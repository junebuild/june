// The durable turn engine, proven against the SAME code that ships — over an
// in-memory SessionStore so the core test stays pure (zero node:*). The native
// seam's real-file durability (crash + fresh process over a persisted db) is
// covered in @junejs/server's agent-native test.

import { describe, expect, test } from "bun:test";
import {
  AgentSession,
  replyStream,
  mintTurnId,
  serializeTurnError,
  withSystem,
  type EventSink,
  type TurnEvent,
  type InboundEvent,
  type Model,
  type ModelReply,
  type Msg,
  type Runtime,
  type ModelFinish,
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
    hasOpeningMessage(t) { return msgs.some((m) => (m.role === "user" || m.role === "trigger") && m.turnId === t); },
    getStep(id) { return steps.has(id) ? steps.get(id) : undefined; },
    putStep(id, o) { steps.set(id, o); },
    delStep(id) { steps.delete(id); },
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
  return (msgs) => {
    if (calls) calls.n++;
    const i = msgs.filter((m) => m.role === "assistant").length;
    return replyStream(script[Math.min(i, script.length - 1)]!);
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

// ── abnormal model finish: the silent-empty-completion killer ──────────────────
// Providers signal truncation/filtering via a finish reason, and both major APIs
// document that such stops may carry NO content. Without the guard, an adapter that
// surfaces the reason would still see the engine commit "" and "complete" the turn —
// a channel then renders nothing and nobody is told why.
describe("abnormal model finish (ModelFinish guard)", () => {
  const modelWith = (reply: ModelReply, finish?: ModelFinish): Model => () => replyStream(reply, finish);

  test("abnormal finish + empty reply fails the turn, with the provider's own value in the error", async () => {
    const rt = new MemRuntime({ ops: { model: modelWith({ text: "", toolCalls: [] }, { reason: "max_tokens", raw: "MAX_TOKENS" }), tools: [] } });
    await expect(rt.session("ops", "s1").turn({ turnId: "t1", userText: "go" })).rejects.toThrow(
      /stopped abnormally — max_tokens \(provider: MAX_TOKENS\) — and returned an empty reply/,
    );
  });

  test("abnormal finish WITH content still completes — truncated-but-usable is the caller's call", async () => {
    const rt = new MemRuntime({ ops: { model: modelWith({ text: "partial ans", toolCalls: [] }, { reason: "max_tokens", raw: "max_tokens" }), tools: [] } });
    expect(await rt.session("ops", "s1").turn({ turnId: "t1", userText: "go" })).toBe("partial ans");
  });

  test("a TOOL CALL is content too — abnormal finish with empty text but a pending call proceeds mid-turn", async () => {
    // e.g. a provider reports its token limit on a round that still carries a valid
    // function call: the call must run and the loop continue, not fail the turn.
    const ping: Tool = { spec: { name: "ping", description: "d", input: { type: "object" } }, run: () => ({ pong: true }) };
    const model: Model = (msgs) =>
      msgs[msgs.length - 1]!.role === "tool"
        ? replyStream({ text: "done after call", toolCalls: [] }, { reason: "stop", raw: "end_turn" })
        : replyStream({ text: "", toolCalls: [{ id: "c1", name: "ping", input: {} }] }, { reason: "max_tokens", raw: "MAX_TOKENS" });
    const rt = new MemRuntime({ ops: { model, tools: [ping] } });
    expect(await rt.session("ops", "s1").turn({ turnId: "t1", userText: "go" })).toBe("done after call");
  });

  test("a no-claim done delta carries NO own finish property — the additive field stays invisible when unused", async () => {
    for await (const d of replyStream({ text: "hi", toolCalls: [] })) {
      expect("finish" in d).toBe(false);
    }
  });

  test("a normal stop with an empty reply still completes — tool-only turns end empty by design", async () => {
    const rt = new MemRuntime({ ops: { model: modelWith({ text: "", toolCalls: [] }, { reason: "stop", raw: "end_turn" }), tools: [] } });
    expect(await rt.session("ops", "s1").turn({ turnId: "t1", userText: "go" })).toBe("");
  });

  test("no finish info keeps legacy behavior — an adapter that makes no claim is not judged", async () => {
    const rt = new MemRuntime({ ops: { model: modelWith({ text: "", toolCalls: [] }), tools: [] } });
    expect(await rt.session("ops", "s1").turn({ turnId: "t1", userText: "go" })).toBe("");
  });

  test("a refusal with empty content fails loudly, not silently", async () => {
    const rt = new MemRuntime({ ops: { model: modelWith({ text: "", toolCalls: [] }, { reason: "refusal" }), tools: [] } });
    await expect(rt.session("ops", "s1").turn({ turnId: "t1", userText: "go" })).rejects.toThrow(/stopped abnormally — refusal/);
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

  test("a streaming model emits reasoning.delta + message.delta live, then the terminal reply (P2)", async () => {
    const streamModel: Model = async function* () {
      yield { type: "reasoning", text: "hmm" };
      yield { type: "text", text: "Hel" };
      yield { type: "text", text: "lo" };
      yield { type: "done", reply: { text: "Hello", toolCalls: [] } };
    };
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), streamModel, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    expect(await s.turn({ turnId: "t1", userText: "hi" })).toBe("Hello"); // done.reply is authoritative
    expect(events.map((e) => e.type)).toEqual([
      "turn.started", "reasoning.delta", "message.delta", "message.delta", "message.completed", "turn.completed",
    ]);
    expect(events.filter((e): e is Extract<TurnEvent, { type: "message.delta" }> => e.type === "message.delta").map((e) => e.text)).toEqual(["Hel", "lo"]);
    expect((events.find((e) => e.type === "reasoning.delta") as Extract<TurnEvent, { type: "reasoning.delta" }>).text).toBe("hmm");
  });

  test("`done` is terminal — a throw AFTER done does not fail an already-completed turn", async () => {
    const model: Model = async function* () {
      yield { type: "text", text: "Hi" };
      yield { type: "done", reply: { text: "Hi", toolCalls: [] } };
      throw new Error("misbehaving model kept going after done"); // must be ignored (iterator cancelled)
    };
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    expect(await s.turn({ turnId: "t1", userText: "hi" })).toBe("Hi"); // completed, not failed
    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "Hi" });
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
    const badModel: Model = () => replyStream({ text: "", toolCalls: [{ id: "c1", name: "nope", input: {} }] });
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), badModel, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    await expect(s.turn({ turnId: "t1", userText: "go" })).rejects.toThrow(/unknown tool nope/);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", turnId: "t1", error: { message: expect.stringContaining("unknown tool") } });
  });

  // #96: turn.failed is serialized at the throw site, where the real Error still exists.
  // For a detached turn this event is the ONLY failure-surfacing path — stack, cause
  // chain, and the in-flight step must survive into it, not flatten to one string.
  test("turn.failed carries stack + causeChain + the in-flight model step (#96)", async () => {
    const model: Model = async function* () {
      throw new Error("api down", { cause: new Error("ECONNRESET") });
      yield { type: "done", reply: { text: "", toolCalls: [] } }; // unreachable; types the generator
    };
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    await expect(s.turn({ turnId: "t1", userText: "go" })).rejects.toThrow("api down");
    const failed = events.at(-1) as Extract<TurnEvent, { type: "turn.failed" }>;
    expect(failed).toMatchObject({
      type: "turn.failed",
      error: { message: "api down", causeChain: ["ECONNRESET"] },
      phase: "model",
      step: "model:1", // the opening user msg is the one message on the transcript
    });
    expect(failed.error.stack).toContain("api down"); // a real trace, not just the message
  });

  test("a failing tool step is attributed: phase tool, step tool:<callId> (#96)", async () => {
    const badModel: Model = () => replyStream({ text: "", toolCalls: [{ id: "c1", name: "nope", input: {} }] });
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), badModel, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    await expect(s.turn({ turnId: "t1", userText: "go" })).rejects.toThrow(/unknown tool/);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", phase: "tool", step: "tool:c1" });
  });

  test("a non-Error throwable keeps its JSON shape instead of '[object Object]' (#96)", async () => {
    const model: Model = async function* () {
      throw { code: 42, hint: "quota" }; // e.g. a provider SDK rejecting with a plain object
      yield { type: "done", reply: { text: "", toolCalls: [] } };
    };
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    await expect(s.turn({ turnId: "t1", userText: "go" })).rejects.toBeDefined();
    const failed = events.at(-1) as Extract<TurnEvent, { type: "turn.failed" }>;
    expect(failed.error.message).toBe('{"code":42,"hint":"quota"}');
    expect(failed.error.stack).toBeUndefined(); // nothing invented for a stackless throwable
  });

  test("result() reports the failed turn with the same full TurnError (#96)", async () => {
    const model: Model = async function* () {
      throw new Error("mid-turn crash", { cause: "disk full" });
      yield { type: "done", reply: { text: "", toolCalls: [] } };
    };
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [], noRuntime);
    const { turnId } = s.start({ userText: "go" });
    const r = await s.result(turnId);
    expect(r).toMatchObject({ status: "failed", error: { message: "mid-turn crash", causeChain: ["disk full"] } });
    if (r.status === "failed") expect(r.error.stack).toContain("mid-turn crash");
  });

  test("serializeTurnError caps a cyclic cause chain instead of spinning (#96)", () => {
    const err = new Error("outer");
    err.cause = err; // hostile/buggy: an error citing itself
    const out = serializeTurnError(err);
    expect(out.message).toBe("outer");
    expect(out.causeChain).toHaveLength(8); // depth-capped, terminated
  });

  // #92: providerState is opaque adapter state that MUST round-trip through replay
  // (Gemini 3+ rejects replays omitting its per-call thoughtSignature). The engine
  // stores it with the call and hands it back untouched — never reads it, never
  // makes it part of identity.
  test("ToolCall.providerState round-trips: stored on the transcript, replayed to the model verbatim (#92)", async () => {
    const seenOnReplay: (string | undefined)[] = [];
    const echo: Tool = { spec: { name: "echo", description: "", input: {} }, run: (input: unknown) => ({ input }) };
    let step = 0;
    const model: Model = (msgs) => {
      if (step++ === 0) {
        return replyStream({ text: "", toolCalls: [{ id: "c1", name: "echo", input: { q: 1 }, providerState: "sig~abc123" }] });
      }
      // the replayed transcript must carry the adapter's state back verbatim
      const assistant = msgs.find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant")!;
      seenOnReplay.push(...assistant.toolCalls.map((c) => c.providerState));
      return replyStream({ text: "done", toolCalls: [] });
    };
    const { store } = memStore();
    const s = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, [echo], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    expect(await s.turn({ turnId: "t1", userText: "go" })).toBe("done");

    expect(seenOnReplay).toEqual(["sig~abc123"]); // handed back untouched on the next model call
    const assistantMsg = store.messages().find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant")!;
    expect(assistantMsg.toolCalls[0]!.providerState).toBe("sig~abc123"); // durably on the transcript
    expect(events.find((e) => e.type === "action.requested")).toMatchObject({ call: { id: "c1", providerState: "sig~abc123" } });
    // identity stays the bare id: the tool step checkpointed under tool:c1, state excluded
    expect(store.getStep("tool:c1")).toBeDefined();
  });

  // #95: minted turn ids are globally unique and lexically time-sortable — the
  // per-actor sequence collided across sessions (every first turn was "t1") and
  // within one session across a DO hibernation (in-memory seq reset re-minted
  // "t1", which hasOpeningMessage treated as a redelivery and silently replayed).
  test("minted turn ids: t_<ULID> format, unique, lexically increasing (#95)", () => {
    const ids = Array.from({ length: 1000 }, () => mintTurnId());
    for (const id of ids) expect(id).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford base32, no I/L/O/U
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids); // monotonic even within one ms burst
    expect("t9" < ids[0]!).toBe(true); // legacy "t<n>" ids sort BEFORE every new id — a mixed ledger stays ordered
  });

  test("two sessions minting concurrently never share a turn id (#95)", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel([{ text: "hi", toolCalls: [] }, { text: "hi", toolCalls: [] }]), tools: [] } });
    const a = rt.session("ops", "s1");
    const b = rt.session("ops", "s2");
    const ea: TurnEvent[] = []; const eb: TurnEvent[] = [];
    a.observe((e) => ea.push(e)); b.observe((e) => eb.push(e));
    await a.turn({ userText: "hi" });
    await b.turn({ userText: "hi" });
    const ta = ea.find((e) => e.type === "turn.started")!.turnId;
    const tb = eb.find((e) => e.type === "turn.started")!.turnId;
    expect(ta).not.toBe(tb); // the crisp-agent qa_feedback failure: both used to be "t1"
  });

  test("a rehydrated session (same store, fresh actor) mints a FRESH id — no silent replay (#95)", async () => {
    // Pre-#95: the second actor's seq reset to 0 → re-minted "t1" → hasOpeningMessage
    // saw the OLD t1 and replayed its cached steps as if redelivered.
    const { store } = memStore();
    const model = scriptedModel([{ text: "first", toolCalls: [] }, { text: "second", toolCalls: [] }]);
    const s1 = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, [], noRuntime);
    await s1.turn({ userText: "one" });
    const s2 = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, [], noRuntime); // hibernation wake
    expect(await s2.turn({ userText: "two" })).toBe("second"); // a NEW turn, not old-t1's cached "first"
    const turnIds = new Set(store.messages().map((m) => m.turnId));
    expect(turnIds.size).toBe(2); // two distinct turns on the durable log
  });

  test("a proactive turn opens with a `trigger`-role seed (attributed), not a user msg (P4 §9)", async () => {
    const store = memStore().store;
    const s = new AgentSession("ops", "s1", store, new MemBroadcaster(), scriptedModel([{ text: "Daily summary: 3 open threads.", toolCalls: [] }]), [], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    await s.turn({ turnId: "t1", userText: "Summarize today's open threads.", trigger: { kind: "proactive", by: "cron:daily" } });
    // durable transcript: the opening is a trigger msg attributed to `by`, NOT a user msg —
    // an honest record that no human sent this.
    const opening = store.messages()[0]!;
    expect(opening).toEqual({ role: "trigger", turnId: "t1", text: "Summarize today's open threads.", by: "cron:daily" });
    // turn.started carries the proactive trigger; the fold surfaces the seed as the turn's prompt.
    expect(events[0]).toMatchObject({ type: "turn.started", trigger: { kind: "proactive", by: "cron:daily" } });
    // the fold surfaces the seed as the turn's prompt AND keeps the attribution
    expect(s.transcript()[0]).toMatchObject({ user: "Summarize today's open threads.", by: "cron:daily", text: "Daily summary: 3 open threads." });
  });

  test("a plain programmatic turn (no explicit trigger) still opens with a user msg", async () => {
    const store = memStore().store;
    const s = new AgentSession("ops", "s1", store, new MemBroadcaster(), scriptedModel([{ text: "ok", toolCalls: [] }]), [], noRuntime);
    await s.turn({ turnId: "t1", userText: "hi" }); // no event, no trigger — an API caller, not an agent-initiated seed
    expect(store.messages()[0]).toEqual({ role: "user", turnId: "t1", text: "hi" });
  });

  test("start() + result() — kick off then await the terminal state", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const s = rt.session("ops", "s1");
    const { turnId } = s.start({ turnId: "t1", userText: "Order 3 widgets" });
    expect(turnId).toBe("t1");
    expect(await s.result("t1")).toEqual({ status: "completed", text: "Done — order placed." });
  });

  test("result() reports a failed turn instead of throwing", async () => {
    const badModel: Model = () => replyStream({ text: "", toolCalls: [{ id: "c1", name: "nope", input: {} }] });
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

  test("fold emits turn.completed even for an empty final response (matches the live engine)", async () => {
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), scriptedModel([{ text: "", toolCalls: [] }]), [], noRuntime);
    await s.turn({ turnId: "t1", userText: "hi" });
    const replayed: TurnEvent[] = [];
    s.observe((e) => replayed.push(e), { turnId: "t1", replay: true });
    expect(replayed).toEqual([{ type: "turn.completed", turnId: "t1", text: "" }]); // no message.completed (empty), but a terminal event
  });

  test("result() still resolves after the in-flight promise is pruned (durable log fallback)", async () => {
    const rt = new MemRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const s = rt.session("ops", "s1");
    s.start({ turnId: "t1", userText: "Order 3 widgets" });
    expect(await s.result("t1")).toEqual({ status: "completed", text: "Done — order placed." }); // from the in-flight promise
    expect(await s.result("t1")).toEqual({ status: "completed", text: "Done — order placed." }); // after prune → from the log
  });
});

describe("suspend / resume (P3 — HITL)", () => {
  // an async tool that asks for external input, then returns the human's answer
  function approveTool(runs?: { n: number }): Tool {
    return {
      spec: { name: "approve", description: "ask a human to approve", input: { type: "object" } },
      run: async (_input, ctx) => {
        if (runs) runs.n++;
        const decision = await ctx.requestInput({ id: "approve-1", prompt: "Approve the refund?" });
        return { approved: decision };
      },
    };
  }
  const APPROVE_SCRIPT: ModelReply[] = [
    { text: "Let me check.", toolCalls: [{ id: "c1", name: "approve", input: {} }] },
    { text: "Approved — refund sent.", toolCalls: [] },
  ];
  const slackEvent = { source: "slack", kind: "message" as const, channelId: "C1", ts: "1.1", user: { id: "U1" }, raw: {} };

  test("a tool suspends the turn for input, then resume() runs it to completion", async () => {
    const modelCalls = { n: 0 };
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), scriptedModel(APPROVE_SCRIPT, modelCalls), [approveTool()], noRuntime);
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));

    const { turnId } = s.start({ turnId: "t1", userText: "refund please", event: slackEvent });
    expect(await s.result(turnId)).toEqual({ status: "suspended", request: { id: "approve-1", prompt: "Approve the refund?", answererId: "U1" } });
    expect(events.at(-1)).toMatchObject({ type: "input.requested", request: { id: "approve-1" } });
    const asked = modelCalls.n; // the model was asked once (the tool-call step)

    s.resume(turnId, "approve-1", true, { by: "U1" });
    expect(await s.result(turnId)).toEqual({ status: "completed", text: "Approved — refund sent." });
    expect(modelCalls.n).toBe(asked + 1); // the pre-suspend model step was cached, not re-asked
    // the continuation announces itself as a resume (of the parking tool call), not a fresh inbound turn
    expect(events.find((e) => e.type === "turn.started" && e.trigger.kind === "resume"))
      .toMatchObject({ trigger: { kind: "resume", callId: "c1" } });
  });

  test("resume enforces the answererId (defaults to the trigger user; absent `by` is denied)", async () => {
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), scriptedModel(APPROVE_SCRIPT), [approveTool()], noRuntime);
    const { turnId } = s.start({ turnId: "t1", userText: "refund please", event: slackEvent });
    await s.result(turnId); // suspended, answererId = U1

    expect(() => s.resume(turnId, "approve-1", true, { by: "U2" })).toThrow(/not authorized/);
    expect(() => s.resume(turnId, "approve-1", true)).toThrow(/not authorized/); // default-deny: no verified resumer
    s.resume(turnId, "approve-1", true, { by: "U1" }); // the trigger user may answer
    expect(await s.result(turnId)).toMatchObject({ status: "completed" });
  });

  test("resume validates the turnId and the inputId against the pending request", async () => {
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), scriptedModel(APPROVE_SCRIPT), [approveTool()], noRuntime);
    const { turnId } = s.start({ turnId: "t1", userText: "refund please" });
    await s.result(turnId); // suspended (no event → no answererId)

    expect(() => s.resume("t9", "approve-1", true)).toThrow(/t9 is not suspended/);
    expect(() => s.resume(turnId, "wrong-id", true)).toThrow(/awaiting input "approve-1", not "wrong-id"/);
    s.resume(turnId, "approve-1", true);
    expect(await s.result(turnId)).toMatchObject({ status: "completed" });
  });

  test("the tool receives the resumed input (exactly-once: not re-run before the answer)", async () => {
    const runs = { n: 0 };
    const { store } = memStore();
    const s = new AgentSession("ops", "s1", store, new MemBroadcaster(), scriptedModel(APPROVE_SCRIPT), [approveTool(runs)], noRuntime);
    const { turnId } = s.start({ turnId: "t1", userText: "refund please", event: slackEvent });
    await s.result(turnId);
    expect(runs.n).toBe(1); // ran once (up to the suspend)

    s.resume(turnId, "approve-1", { approvedBy: "U1" }, { by: "U1" });
    await s.result(turnId);
    // the tool re-ran on resume (it hadn't committed), got the input, and its result carries it
    const toolMsg = store.messages().find((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool" && m.name === "approve");
    expect(toolMsg!.result).toEqual({ approved: { approvedBy: "U1" } });
  });

  test("a tool can ask for TWO inputs sequentially (park → resume → park → resume)", async () => {
    const twoAsks: Tool = {
      spec: { name: "ask2", description: "asks twice", input: { type: "object" } },
      run: async (_i, ctx) => ({
        first: await ctx.requestInput({ id: "q1", prompt: "first?" }),
        second: await ctx.requestInput({ id: "q2", prompt: "second?" }),
      }),
    };
    const model = scriptedModel([
      { text: "asking", toolCalls: [{ id: "c1", name: "ask2", input: {} }] },
      { text: "both answered", toolCalls: [] },
    ]);
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [twoAsks], noRuntime);
    const { turnId } = s.start({ turnId: "t1", userText: "go" });
    expect(await s.result(turnId)).toMatchObject({ status: "suspended", request: { id: "q1" } });
    s.resume(turnId, "q1", "A");
    expect(await s.result(turnId)).toMatchObject({ status: "suspended", request: { id: "q2" } }); // parked again
    s.resume(turnId, "q2", "B");
    expect(await s.result(turnId)).toEqual({ status: "completed", text: "both answered" });
  });

  test("answers are turn-scoped: a later turn re-asking the same id parks again", async () => {
    // same input id every turn — turn 2 must ask its own human, never reuse turn 1's answer
    // (an approval must not carry over to the next refund).
    const model: Model = (msgs) => {
      const assistants = msgs.filter((m) => m.role === "assistant").length;
      return replyStream(
        assistants % 2 === 0
          ? { text: "asking", toolCalls: [{ id: `c${assistants}`, name: "approve", input: {} }] }
          : { text: "done", toolCalls: [] },
      );
    };
    const { store } = memStore();
    const s = new AgentSession("ops", "s1", store, new MemBroadcaster(), model, [approveTool()], noRuntime);
    const t1 = s.start({ turnId: "t1", userText: "one" }).turnId;
    expect(await s.result(t1)).toMatchObject({ status: "suspended" });
    s.resume(t1, "approve-1", "yes-1");
    expect(await s.result(t1)).toMatchObject({ status: "completed" });

    const t2 = s.start({ turnId: "t2", userText: "two" }).turnId;
    expect(await s.result(t2)).toMatchObject({ status: "suspended", request: { id: "approve-1" } }); // asked AGAIN
    s.resume(t2, "approve-1", "yes-2");
    expect(await s.result(t2)).toMatchObject({ status: "completed" });
    const approvals = store.messages().filter((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool" && m.name === "approve");
    expect(approvals.map((m) => m.result)).toEqual([{ approved: "yes-1" }, { approved: "yes-2" }]);
  });

  test("a NEW turn is rejected while one is parked; redelivering the parked turn re-parks", async () => {
    const events: TurnEvent[] = [];
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), scriptedModel(APPROVE_SCRIPT), [approveTool()], noRuntime);
    s.observe((e) => events.push(e));
    const { turnId } = s.start({ turnId: "t1", userText: "refund please" });
    await s.result(turnId); // parked — the transcript ends in the dangling approve call

    // a new turn on the dangling transcript would corrupt both turns — loud rejection
    expect(() => s.start({ turnId: "t2", userText: "unrelated" })).toThrow(/suspended awaiting input "approve-1"/);

    // but a redelivery of the SAME parked turn replays and re-announces the request
    s.start({ turnId: "t1", userText: "refund please" });
    expect(await s.result(turnId)).toMatchObject({ status: "suspended", request: { id: "approve-1" } });
    expect(events.filter((e) => e.type === "input.requested").length).toBe(2);

    s.resume(turnId, "approve-1", true);
    expect(await s.result(turnId)).toMatchObject({ status: "completed" });
  });

  test("requestInput from a SYNC tool fails the turn loudly (it cannot park)", async () => {
    const syncMisuse: Tool = {
      spec: { name: "bad", description: "sync tool misusing requestInput", input: { type: "object" } },
      run: (_i, ctx) => ctx.requestInput({ id: "x", prompt: "?" }), // sync run — commits in the tool tx
    };
    const model = scriptedModel([{ text: "trying", toolCalls: [{ id: "c1", name: "bad", input: {} }] }]);
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [syncMisuse], noRuntime);
    const { turnId } = s.start({ turnId: "t1", userText: "go" });
    const r = await s.result(turnId);
    expect(r).toMatchObject({ status: "failed" });
    expect((r as Extract<typeof r, { status: "failed" }>).error.message).toMatch(/runs sync .* only an async tool can park/);
  });

  test("resume synchronously from an input.requested observer keeps the continuation (running-map race)", async () => {
    // resume() runs while the parked promise is still pending; its late cleanup must NOT clear
    // the continuation's running[turnId] entry (delete is tied to the promise identity).
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), scriptedModel(APPROVE_SCRIPT), [approveTool()], noRuntime);
    let resumed = false;
    s.observe((e) => { if (e.type === "input.requested" && !resumed) { resumed = true; s.resume("t1", "approve-1", true, { by: "U1" }); } });
    s.start({ turnId: "t1", userText: "refund please", event: slackEvent });
    await new Promise((r) => setTimeout(r, 20)); // let park→cleanup→resume→continuation settle
    expect(await s.result("t1")).toEqual({ status: "completed", text: "Approved — refund sent." }); // not a spurious failure
  });
});

describe("withSystem", () => {
  test("injects the system prompt into every model call (def-authoritative)", async () => {
    let seen: string | undefined;
    const capture: Model = (_m, _t, opts) => { seen = opts?.system; return replyStream({ text: "ok", toolCalls: [] }); };
    const wrapped = withSystem(capture, "You are Ops.");
    await wrapped([{ role: "user", turnId: "t1", text: "hi" }], []);
    expect(seen).toBe("You are Ops.");
  });

  test("APPENDS a per-turn overlay (opts.system) to the base, or uses base alone", async () => {
    let seen: string | undefined;
    const capture: Model = (_m, _t, opts) => { seen = opts?.system; return replyStream({ text: "ok", toolCalls: [] }); };
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
    const capture: Model = (_m, _t, opts) => { seen.push(opts?.system); return replyStream({ text: "ok", toolCalls: [] }); };
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

// ── the principal gate: requiresPrincipal tools exist only on identified turns ──
describe("principal gate (requiresPrincipal)", () => {
  const gated: Tool = {
    spec: { name: "get_orders", description: "tenant-scoped data", input: { type: "object", properties: {} } },
    requiresPrincipal: true,
    run: (_i: unknown, ctx) => ({ who: ctx.principal?.id, tenant: (ctx.principal as { tenant?: string } | undefined)?.tenant }),
  };
  const open: Tool = {
    spec: { name: "faq", description: "public knowledge", input: { type: "object", properties: {} } },
    run: () => "public",
  };
  const ev = (principal?: { id: string; [k: string]: unknown }): InboundEvent =>
    ({ source: "crisp", kind: "message", channelId: "w1", threadId: "s1", ts: "1", principal });
  // A model that records the tool names it was OFFERED each call, then follows the script.
  function offeredModel(script: ModelReply[], offered: string[][]): Model {
    return (msgs, tools) => {
      offered.push(tools.map((t) => t.name));
      const i = msgs.filter((m) => m.role === "assistant").length;
      return replyStream(script[Math.min(i, script.length - 1)]!);
    };
  }

  test("anonymous turn: the model never sees a gated tool; open tools remain", async () => {
    const offered: string[][] = [];
    const model = offeredModel([{ text: "just words", toolCalls: [] }], offered);
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [gated, open], noRuntime);
    const { turnId } = s.start({ userText: "hi", event: ev(undefined) });
    expect(await s.result(turnId)).toMatchObject({ status: "completed" });
    expect(offered[0]).toEqual(["faq"]); // get_orders absent by construction
  });

  test("identified turn: the gated tool is offered and its ctx carries the principal", async () => {
    const offered: string[][] = [];
    const seenByTool: unknown[] = [];
    const capturing: Tool = {
      ...gated,
      run: (_i: unknown, ctx) => { seenByTool.push(ctx.principal); return "ok"; },
    };
    const model = offeredModel(
      [{ text: "", toolCalls: [{ id: "c1", name: "get_orders", input: {} }] }, { text: "done", toolCalls: [] }],
      offered,
    );
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [capturing, open], noRuntime);
    const { turnId } = s.start({ userText: "my orders?", event: ev({ id: "owner@school.tw", tenant: "acme" }) });
    expect(await s.result(turnId)).toMatchObject({ status: "completed", text: "done" });
    expect(offered[0]).toEqual(["get_orders", "faq"]);
    expect(seenByTool).toEqual([{ id: "owner@school.tw", tenant: "acme" }]);
  });

  test("a hallucinated gated call on an anonymous turn fails loudly (unknown tool)", async () => {
    const model = offeredModel([{ text: "", toolCalls: [{ id: "c1", name: "get_orders", input: {} }] }], []);
    const s = new AgentSession("ops", "s1", memStore().store, new MemBroadcaster(), model, [gated, open], noRuntime);
    const { turnId } = s.start({ userText: "hi", event: ev(undefined) });
    expect(await s.result(turnId)).toMatchObject({ status: "failed", error: { message: "unknown tool get_orders" } });
  });
});
