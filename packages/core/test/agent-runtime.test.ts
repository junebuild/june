// The durable turn engine, proven against the SAME code that ships — over an
// in-memory SessionStore so the core test stays pure (zero node:*). The native
// seam's real-file durability (crash + fresh process over a persisted db) is
// covered in @junejs/server's agent-native test.

import { describe, expect, test } from "bun:test";
import {
  AgentSession,
  withSystem,
  type EventSink,
  type TurnEvent,
  type InboundEvent,
  type Model,
  type ModelReply,
  type Msg,
  type Runtime,
  type SessionStore,
  type Tool,
} from "@junejs/core/agent-runtime";

// ── an in-memory SessionStore (pure). `app` is the side-effect target a local
// tool writes via unwrap() — stands in for "any table a tool writes in the same
// tx as the checkpoint". Reusing the same store instance across two AgentSessions
// simulates a replay after a crash (state persists; in-process handles are gone).
function memStore() {
  const msgs: Msg[] = [];
  const steps = new Map<string, unknown>();
  let status = "new";
  const app: { orders: { item: string; qty: number }[] } = { orders: [] };
  const store: SessionStore = {
    appendMessage(m) { msgs.push(m); },
    messages() { return msgs.slice(); },
    hasUserTurn(t) { return msgs.some((m) => m.role === "user" && m.turnId === t); },
    getStep(id) { return steps.has(id) ? steps.get(id) : undefined; },
    putStep(id, o) { steps.set(id, o); },
    getStatus() { return status; },
    setStatus(s) { status = s; },
    tx(fn) { return fn(); },
    unwrap<H = unknown>(): H { return app as unknown as H; },
  };
  return { store, app };
}

class MemBroadcaster implements EventSink {
  private subs = new Set<(e: TurnEvent) => void>();
  emit(e: TurnEvent) { this.subs.forEach((cb) => { try { cb(e); } catch { /* a bad subscriber must not break emit */ } }); }
  subscribe(cb: (e: TurnEvent) => void) { this.subs.add(cb); return () => this.subs.delete(cb); }
}

type AgentDef = { model: Model; tools: Tool[] };

// An in-memory Runtime: hands out (and memoizes) an AgentSession per (agent, id),
// each over its own memStore. Mirrors @junejs/server's NativeRuntime.
class MemRuntime implements Runtime {
  private actors = new Map<string, AgentSession>();
  private apps = new Map<string, { orders: { item: string; qty: number }[] }>();
  private readonly agents: Record<string, AgentDef>;
  constructor(agents: Record<string, AgentDef>) {
    this.agents = agents;
  }
  session(agent: string, id: string): AgentSession {
    const key = `${agent}:${id}`;
    let a = this.actors.get(key);
    if (!a) {
      const def = this.agents[agent];
      if (!def) throw new Error(`unknown agent: ${agent}`);
      const { store, app } = memStore();
      this.apps.set(key, app);
      a = new AgentSession(agent, id, store, new MemBroadcaster(), def.model, def.tools, this);
      this.actors.set(key, a);
    }
    return a;
  }
}

// A deterministic scripted model: reply N is chosen by how many assistant
// messages already exist; it counts its own invocations so a test can assert a
// memoized step is NOT re-asked.
function scriptedModel(script: ModelReply[], calls?: { n: number }): Model {
  return async (msgs) => {
    if (calls) calls.n++;
    const i = msgs.filter((m) => m.role === "assistant").length;
    return script[Math.min(i, script.length - 1)]!;
  };
}

const ORDER_SCRIPT: ModelReply[] = [
  { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
  { text: "Done — order placed.", toolCalls: [] },
];

// A LOCAL tool (sync run): its side effect commits in the same tx as the
// checkpoint → exactly-once. Counts real executions (skipped replays don't count).
function createOrderTool(runs?: { n: number }): Tool {
  return {
    spec: { name: "create_order", description: "Place an order", input: { type: "object" } },
    run: (input: { item: string; qty: number }, ctx) => {
      if (runs) runs.n++;
      const app = ctx.store.unwrap<{ orders: { item: string; qty: number }[] }>();
      app.orders.push({ item: input.item, qty: input.qty });
      return { orderId: app.orders.length, item: input.item, qty: input.qty };
    },
  };
}

const noRuntime: Runtime = { session() { throw new Error("no subagents in this test"); } };

describe("agent-runtime engine", () => {
  test("a durable turn runs the model↔tool loop to completion", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const answer = await rt.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(answer).toBe("Done — order placed.");
    const turn = rt.session("ops", "s1").transcript()[0]!;
    expect(turn.user).toBe("Order 3 widgets");
    expect(turn.steps).toEqual([{ name: "create_order", done: true, result: { orderId: 1, item: "widget", qty: 3 } }]);
    expect(turn.text).toBe("Done — order placed.");
    expect(rt.session("ops", "s1").snapshot().status).toBe("done");
  });

  test("local tool side effect is exactly-once across a crash + replay", async () => {
    const { store, app } = memStore();
    const runs = { n: 0 };
    const model = scriptedModel(ORDER_SCRIPT);
    const tools = [createOrderTool(runs)];

    // crash right AFTER the tool tx commits (side effect + checkpoint durable)
    const s1 = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, tools, noRuntime);
    await expect(
      s1.turn({ turnId: "t1", userText: "Order 3 widgets", crash: { at: "after-tool-commit", step: "tool:c1" } }),
    ).rejects.toThrow(/CRASH after-tool-commit/);
    expect(app.orders).toHaveLength(1);

    // replay over the SAME store via a fresh AgentSession (in-process state gone)
    const s2 = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, tools, noRuntime);
    const answer = await s2.turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(answer).toBe("Done — order placed.");
    expect(app.orders).toHaveLength(1); // still one — the committed step was skipped, not re-run
    expect(runs.n).toBe(1); // tool executed once total, never on replay
  });

  test("a committed model step is memoized — replay does not re-invoke the model for it", async () => {
    const { store } = memStore();
    const modelCalls = { n: 0 };
    const model = scriptedModel(ORDER_SCRIPT, modelCalls);
    const tools = [createOrderTool()];

    const s1 = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, tools, noRuntime);
    await expect(
      s1.turn({ turnId: "t1", userText: "Order 3 widgets", crash: { at: "after-model-commit", step: "model:1" } }),
    ).rejects.toThrow(/CRASH after-model-commit/);
    expect(modelCalls.n).toBe(1); // model:1 asked once

    const s2 = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, tools, noRuntime);
    await s2.turn({ turnId: "t1", userText: "Order 3 widgets" });
    expect(modelCalls.n).toBe(2); // model:1 (pre-crash) + model:3 (post-replay); model:1 NOT re-asked
  });

  test("checkpoint keys are session-scoped — same step ids across sessions don't collide", async () => {
    // Regression for the cross-session collision that spun the loop at 99% CPU:
    // both sessions produce identical step ids; a shared step table would let one
    // read the other's checkpoint, never append, and loop forever.
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const a = await rt.session("ops", "alice").turn({ turnId: "t1", userText: "Order 3 widgets" });
    const b = await rt.session("ops", "bob").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(a).toBe("Done — order placed.");
    expect(b).toBe("Done — order placed.");
    expect(rt.session("ops", "alice").transcript()).toHaveLength(1);
    expect(rt.session("ops", "bob").transcript()).toHaveLength(1);
  });

  test("turns are serialized — concurrent turn() calls don't interleave", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const session = rt.session("ops", "s1");
    const [r1, r2] = await Promise.all([
      session.turn({ turnId: "t1", userText: "first" }),
      session.turn({ turnId: "t2", userText: "second" }),
    ]);

    expect(r1).toBe("Done — order placed.");
    expect(r2).toBe("Done — order placed.");
    const transcript = session.transcript();
    expect(transcript.map((t) => t.user)).toEqual(["first", "second"]);
    expect(transcript.every((t) => t.text === "Done — order placed." && t.steps.every((s) => s.done))).toBe(true);
  });

  test("subagent = child actor: a tool spawns a child session that runs durably", async () => {
    const researcher: AgentDef = {
      model: scriptedModel([{ text: "widgets are trending; buy 3", toolCalls: [] }]),
      tools: [],
    };
    const askResearcher: Tool = {
      subagent: true,
      spec: { name: "ask_researcher", description: "Delegate to the researcher subagent", input: { type: "object" } },
      run: async (input: { q: string }, ctx) => {
        const child = ctx.runtime.session("researcher", `${ctx.sessionId}:sub:${ctx.callId}`);
        return { answer: await child.turn({ userText: input.q }) };
      },
    };
    const ops: AgentDef = {
      model: scriptedModel([
        { text: "Let me research that.", toolCalls: [{ id: "c1", name: "ask_researcher", input: { q: "should I order widgets?" } }] },
        { text: "Research says: widgets are trending; buy 3", toolCalls: [] },
      ]),
      tools: [askResearcher],
    };

    const rt = new MemRuntime({ ops, researcher });
    const answer = await rt.session("ops", "s1").turn({ turnId: "t1", userText: "should I order widgets?" });

    expect(answer).toBe("Research says: widgets are trending; buy 3");
    const turn = rt.session("ops", "s1").transcript()[0]!;
    expect(turn.steps[0]).toEqual({ name: "ask_researcher", done: true, result: { answer: "widgets are trending; buy 3" } });
    // child actor ran its own durable turn (id = `${parentSessionId}:sub:${callId}`)
    const childTranscript = rt.session("researcher", "s1:sub:c1").transcript();
    expect(childTranscript).toHaveLength(1);
    expect(childTranscript[0]!.text).toBe("widgets are trending; buy 3");
  });
});

describe("TurnEvent stream (P1)", () => {
  test("a turn emits a structured event stream (started → message/action → completed)", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const s = rt.session("ops", "s1");
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));

    await s.turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(events.map((e) => e.type)).toEqual([
      "turn.started", "message.completed", "action.requested", "action.completed", "message.completed", "turn.completed",
    ]);
    expect(events[0]).toMatchObject({ type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "system" } });
    expect(events[2]).toMatchObject({ type: "action.requested", call: { name: "create_order" } });
    expect(events[3]).toMatchObject({ type: "action.completed", call: { name: "create_order" }, result: { orderId: 1 } });
    expect(events.at(-1)).toEqual({ type: "turn.completed", turnId: "t1", text: "Done — order placed." });
  });

  test("an inbound event becomes the turn.started trigger", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel([{ text: "hi", toolCalls: [] }]), tools: [] } });
    const s = rt.session("ops", "s1");
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    const event: InboundEvent = { source: "slack", kind: "app_mention", channelId: "C1", ts: "1.1", raw: {} };
    await s.turn({ turnId: "t1", userText: "hey", event });
    expect(events[0]).toMatchObject({ type: "turn.started", trigger: { kind: "inbound", event: { source: "slack" } } });
  });

  test("a throwing turn emits turn.failed (and rethrows)", async () => {
    const badModel: Model = async () => ({ text: "", toolCalls: [{ id: "c1", name: "nope", input: {} }] });
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), badModel, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    await expect(s.turn({ turnId: "t1", userText: "go" })).rejects.toThrow(/unknown tool nope/);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", turnId: "t1", error: { message: expect.stringContaining("unknown tool") } });
  });

  test("start() + result() — kick off then await the terminal state", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const s = rt.session("ops", "s1");
    const { turnId } = s.start({ turnId: "t1", userText: "Order 3 widgets" });
    expect(turnId).toBe("t1");
    expect(await s.result("t1")).toEqual({ status: "completed", text: "Done — order placed." });
  });

  test("result() reports a failed turn instead of throwing", async () => {
    const badModel: Model = async () => ({ text: "", toolCalls: [{ id: "c1", name: "nope", input: {} }] });
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), badModel, [], noRuntime);
    s.start({ turnId: "t1", userText: "go" });
    const r = await s.result("t1");
    expect(r).toMatchObject({ status: "failed", error: { message: expect.stringContaining("unknown tool") } });
  });

  test("observe({turnId, replay}) folds the structural prefix from the log, then live (no turn.started)", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const s = rt.session("ops", "s1");
    await s.turn({ turnId: "t1", userText: "Order 3 widgets" }); // completes BEFORE we attach

    const replayed: TurnEvent[] = [];
    s.observe((e) => replayed.push(e), { turnId: "t1", replay: true });

    expect(replayed.map((e) => e.type)).toEqual([
      "message.completed", "action.requested", "action.completed", "message.completed", "turn.completed",
    ]);
    expect(replayed.find((e) => e.type === "turn.started")).toBeUndefined(); // trigger is live-only, not folded
    expect(replayed.at(-1)).toEqual({ type: "turn.completed", turnId: "t1", text: "Done — order placed." });
    const done = replayed.find((e) => e.type === "action.completed") as Extract<TurnEvent, { type: "action.completed" }>;
    expect(done.call).toMatchObject({ name: "create_order", input: { item: "widget", qty: 3 } }); // input recovered
  });
});

describe("withSystem", () => {
  test("injects the system prompt into every model call (def-authoritative)", async () => {
    let seen: string | undefined;
    const capture: Model = async (_m, _t, opts) => { seen = opts?.system; return { text: "ok", toolCalls: [] }; };
    const wrapped = withSystem(capture, "You are Ops.");
    await wrapped([{ role: "user", turnId: "t1", text: "hi" }], []);
    expect(seen).toBe("You are Ops.");
  });

  test("APPENDS a per-turn overlay (opts.system) to the base, or uses base alone", async () => {
    let seen: string | undefined;
    const capture: Model = async (_m, _t, opts) => { seen = opts?.system; return { text: "ok", toolCalls: [] }; };
    const wrapped = withSystem(capture, "BASE");
    await wrapped([], [], { system: "OVERLAY" });
    expect(seen).toBe("BASE\n\nOVERLAY");
    await wrapped([], []);
    expect(seen).toBe("BASE");
  });
});

describe("channelInstructions overlay (C — real source into the prompt)", () => {
  const capturingSession = (channelInstructions?: Record<string, string>) => {
    const seen: (string | undefined)[] = [];
    const capture: Model = async (_m, _t, opts) => { seen.push(opts?.system); return { text: "ok", toolCalls: [] }; };
    const { store } = memStore();
    const session = new AgentSession("ops", "s1", store, new MemBroadcaster(), withSystem(capture, "BASE"), [], noRuntime, channelInstructions);
    return { session, seen };
  };
  const ev = (source: string): InboundEvent => ({ source, kind: "message", channelId: "C", threadId: "T", ts: "1", raw: {} });

  test("appends the source-matched overlay for that turn; base-only otherwise", async () => {
    const { session, seen } = capturingSession({ slack: "ASSIST-MODE", crisp: "CRISP-NOTE" });
    await session.turn({ turnId: "t1", userText: "hi", event: ev("slack") });
    expect(seen.at(-1)).toBe("BASE\n\nASSIST-MODE");            // real source → overlay
    await session.turn({ turnId: "t2", userText: "hi", event: ev("crisp") });
    expect(seen.at(-1)).toBe("BASE\n\nCRISP-NOTE");
    await session.turn({ turnId: "t3", userText: "hi", event: ev("web") });
    expect(seen.at(-1)).toBe("BASE");                          // unknown source → no overlay
    await session.turn({ turnId: "t4", userText: "hi" });
    expect(seen.at(-1)).toBe("BASE");                          // no event → no overlay
  });

  test("no channelInstructions ⇒ always base only", async () => {
    const { session, seen } = capturingSession(undefined);
    await session.turn({ turnId: "t1", userText: "hi", event: ev("slack") });
    expect(seen.at(-1)).toBe("BASE");
  });
});
