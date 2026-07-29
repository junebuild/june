// The Durable Object edge seam, proven WITHOUT workerd: a fake SqlStorage backed
// by the same synchronous SQLite the DO would use (ctx.storage.sql is synchronous
// too), so the DoSessionStore durability contract runs under bun:test. Reusing
// one fake storage across two DoSessionStores models DO hibernation/eviction —
// storage persists, in-process state is gone. Also drives AgentDurableObject end
// to end and checks the backend selector.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  AgentSession,
  replyStream,
  type EventSink,
  type InboundEvent,
  type Model,
  type ModelDelta,
  type ModelReply,
  type Runtime,
  type Tool,
  type TurnEvent,
} from "@junejs/core/agent-runtime";
import {
  AgentDurableObject,
  DoSessionStore,
  durableAgentSurface,
  durableChannelSurface,
  durableFetch,
  SESSION_HEADER,
  sseTurnFinalText,
  sseTurnEvents,
  type DurableObjectNamespace,
  type DurableStorage,
  type SqlStorage,
} from "../src/agent-durable";
import { createAgentRuntime, mountAgent } from "../src/agent-native";
import { defineChannel, DeliverUnsupportedError, type AgentDefinition, type Channel } from "@junejs/core/agent-config";
import { openLocalSqliteSync } from "../src/sqlite-driver";
import { db, currentServices, requestLocal } from "@junejs/db";
import type { JuneDb } from "@junejs/core/resources";

// A stand-in for ctx.storage: the Cloudflare SqlStorage surface (synchronous
// .exec() + a synchronous transaction) over bun:sqlite.
async function fakeStorage(): Promise<DurableStorage & { close(): void }> {
  const db = await openLocalSqliteSync(":memory:");
  const sql: SqlStorage = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings) as T[];
      return { toArray: () => rows, one: () => rows[0]! };
    },
  };
  return {
    sql,
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}

const open: { close(): void }[] = [];
async function storage() {
  const s = await fakeStorage();
  open.push(s);
  return s;
}
afterEach(() => { while (open.length) open.pop()!.close(); });

class TestBroadcaster implements EventSink {
  emit() {}
  subscribe() { return () => {}; }
}
const noRuntime: Runtime = { session() { throw new Error("no subagents"); } };

function scriptedModel(script: ModelReply[]): Model {
  return (msgs) => replyStream(script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!);
}
const ORDER_SCRIPT: ModelReply[] = [
  { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
  { text: "Done — order placed.", toolCalls: [] },
];

// A local tool writing an app table via the DO's sql handle (unwrap) — same tx as
// the checkpoint ⇒ exactly-once.
function createOrderTool(runs?: { n: number }): Tool {
  return {
    spec: { name: "create_order", description: "Place an order", input: { type: "object" } },
    run: (input: { item: string; qty: number }, ctx) => {
      if (runs) runs.n++;
      const sql = ctx.store.unwrap<SqlStorage>();
      sql.exec(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT, qty INTEGER)`);
      sql.exec("INSERT INTO orders (item, qty) VALUES (?, ?)", input.item, input.qty);
      const id = Number(sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id);
      return { orderId: id, item: input.item, qty: input.qty };
    },
  };
}
function countOrders(s: DurableStorage): number {
  s.sql.exec(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT, qty INTEGER)`);
  return Number(s.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM orders").one().n);
}

describe("DoSessionStore (edge durability seam)", () => {
  test("a durable turn runs to completion over ctx.storage.sql", async () => {
    const s = await storage();
    const session = new AgentSession("ops", "self", new DoSessionStore(s), new TestBroadcaster(), scriptedModel(ORDER_SCRIPT), [createOrderTool()], noRuntime);
    const answer = await session.turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(answer).toBe("Done — order placed.");
    const turn = session.transcript()[0]!;
    expect(turn.steps).toEqual([{ name: "create_order", done: true, result: { orderId: 1, item: "widget", qty: 3 } }]);
  });

  test("exactly-once across a crash + a fresh store over the SAME storage (models DO eviction)", async () => {
    const s = await storage();
    const runs = { n: 0 };
    const model = scriptedModel(ORDER_SCRIPT);
    const tools = [createOrderTool(runs)];

    const s1 = new AgentSession("ops", "self", new DoSessionStore(s), new TestBroadcaster(), model, tools, noRuntime);
    await expect(
      s1.turn({ turnId: "t1", userText: "Order 3 widgets", crash: { at: "after-tool-commit", step: "tool:c1" } }),
    ).rejects.toThrow(/CRASH after-tool-commit/);
    expect(countOrders(s)).toBe(1);

    // fresh AgentSession + fresh DoSessionStore, same underlying storage
    const s2 = new AgentSession("ops", "self", new DoSessionStore(s), new TestBroadcaster(), model, tools, noRuntime);
    expect(await s2.turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");
    expect(countOrders(s)).toBe(1); // committed step skipped, not re-run
    expect(runs.n).toBe(1);
  });

  test("one DO = one session: separate DOs with identical step ids don't collide", async () => {
    const a = await storage();
    const b = await storage();
    const mk = (s: DurableStorage) => new AgentSession("ops", "self", new DoSessionStore(s), new TestBroadcaster(), scriptedModel(ORDER_SCRIPT), [createOrderTool()], noRuntime);
    expect(await mk(a).turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");
    expect(await mk(b).turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");
    expect(countOrders(a)).toBe(1);
    expect(countOrders(b)).toBe(1);
  });
});

describe("AgentDurableObject", () => {
  test("merges a channel's capability tools, built from the DO env, into the turn (B)", async () => {
    const s = await storage();
    let sawEnv: unknown;
    // a channel FACTORY: its tools() run closures can't cross the RPC, so the DO builds
    // them here from its own env. The turn must be able to dispatch the channel tool.
    const factory = (env: unknown) => { sawEnv = env; return defineChannel({ name: "x", path: "/x", tools: () => [channelPing] }); };
    const channelPing: Tool = { spec: { name: "channel_ping", description: "d", input: { type: "object" } }, run: () => ({ pong: true }) };
    const model = scriptedModel([
      { text: "calling channel tool", toolCalls: [{ id: "c1", name: "channel_ping", input: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model, tools: [], channels: [factory], env: { BOT: "xoxb" } });

    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "go", turnId: "t1" }) }));
    expect(await sseTurnFinalText(res)).toBe("done"); // dispatched channel_ping (not "unknown tool")
    expect(sawEnv).toEqual({ BOT: "xoxb" });            // channel tools were resolved with the DO env
  });

  test("the session initiator crosses the /turn RPC and outlives the turn that set it (#128)", async () => {
    const s = await storage();
    const seen: { principal?: string; initiator?: string }[] = [];
    const idProbe: Tool = {
      spec: { name: "id_probe", description: "record identities", input: { type: "object" } },
      run: (_i, ctx) => {
        seen.push({ principal: (ctx.principal as { id?: string } | undefined)?.id, initiator: (ctx.initiator as { id?: string } | undefined)?.id });
        return { ok: true };
      },
    };
    const probeModel: Model = (msgs) => {
      const last = msgs[msgs.length - 1]!;
      if (last.role === "tool") return replyStream({ text: "done", toolCalls: [] });
      const turnId = last.role === "user" || last.role === "trigger" ? last.turnId : "t?";
      return replyStream({ text: "probing", toolCalls: [{ id: `ip-${turnId}`, name: "id_probe", input: {} }] });
    };
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: probeModel, tools: [idProbe] });
    const evt = (id: string) => ({ source: "slack", kind: "message", channelId: "C1", ts: "1.1", principal: { id } });

    const turn = (turnId: string, principalId: string) =>
      agent.fetch(new Request("https://do/turn", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ userText: "hi", turnId, event: evt(principalId) }) }));
    expect(await sseTurnFinalText(await turn("t1", "A"))).toBe("done");
    expect(await sseTurnFinalText(await turn("t2", "B"))).toBe("done");
    expect(seen).toEqual([
      { principal: "A", initiator: "A" },
      { principal: "B", initiator: "A" }, // B speaks; A opened the session — durable across turns
    ]);
  });

  test("POST /turn streams the TurnEvent sequence as SSE", async () => {
    const s = await storage();
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] });
    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "Order 3 widgets", turnId: "t1" }) }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events: TurnEvent[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (line) events.push(JSON.parse(line.slice(5).trim()));
      }
      if (done) break;
    }
    expect(events.map((e) => e.type)).toEqual([
      "turn.started", "message.completed", "action.requested", "action.completed", "message.completed", "turn.completed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "Done — order placed." });
  });

  test("POST /turn suspends on requestInput; POST /resume streams the continuation (P3)", async () => {
    const s = await storage();
    const approve: Tool = {
      spec: { name: "approve", description: "ask a human", input: { type: "object" } },
      run: async (_i, ctx) => ({ approved: await ctx.requestInput({ id: "a1", prompt: "Approve?" }) }),
    };
    const model = scriptedModel([
      { text: "checking", toolCalls: [{ id: "c1", name: "approve", input: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model, tools: [approve] });
    const collect = async (res: Response) => { const out: TurnEvent[] = []; for await (const e of sseTurnEvents(res)) out.push(e); return out; };

    const t = await collect(await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "please", turnId: "t1" }) })));
    expect(t.at(-1)).toMatchObject({ type: "input.requested", request: { id: "a1" } }); // parked, stream closed
    expect(t.some((e) => e.type === "turn.completed")).toBe(false);

    const r = await collect(await agent.fetch(new Request("https://do/resume", { method: "POST", body: JSON.stringify({ turnId: "t1", inputId: "a1", input: true }) })));
    expect(r.at(-1)).toMatchObject({ type: "turn.completed", text: "done" }); // resumed to completion
  });

  test("/resume and /turn map suspension conflicts to 4xx, not a crash (P3)", async () => {
    const s = await storage();
    const approve: Tool = {
      spec: { name: "approve", description: "ask a human", input: { type: "object" } },
      run: async (_i, ctx) => ({ approved: await ctx.requestInput({ id: "a1", prompt: "Approve?" }) }),
    };
    const model = scriptedModel([
      { text: "checking", toolCalls: [{ id: "c1", name: "approve", input: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model, tools: [approve] });
    const post = (path: string, body: unknown) => agent.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) }));

    // nothing suspended yet → 409
    expect((await post("/resume", { turnId: "t1", inputId: "a1", input: true })).status).toBe(409);

    // park t1 with an answererId (trigger user U1 from the inbound event)
    const event = { source: "slack", kind: "message", channelId: "C1", ts: "1.1", user: { id: "U1" } };
    const res = await post("/turn", { userText: "refund", turnId: "t1", event });
    for await (const _ of sseTurnEvents(res)) { /* drain to the park */ }

    expect((await post("/turn", { userText: "another", turnId: "t2" })).status).toBe(409);                    // parked session refuses a new turn
    expect((await post("/resume", { turnId: "t1", inputId: "a1", input: true, by: "U2" })).status).toBe(403); // wrong answerer
    expect((await post("/resume", { turnId: "t1", inputId: "a1", input: true })).status).toBe(403);           // unidentified resumer (default-deny)
    expect((await post("/resume", { turnId: "t1", inputId: "nope", input: true, by: "U1" })).status).toBe(409); // wrong input id

    const ok = await post("/resume", { turnId: "t1", inputId: "a1", input: true, by: "U1" });
    const events: TurnEvent[] = [];
    for await (const e of sseTurnEvents(ok)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "done" });
  });

  test("two parks in one session survive the INSERT-only steps table (P3)", async () => {
    // regression: `suspended` is a fixed step key and DoSessionStore.putStep is INSERT-only —
    // a second park must not hit the PK, and a turn-2 re-ask of the same input id must park
    // again (turn-scoped answers), never silently reuse turn 1's answer.
    const ask: Tool = {
      spec: { name: "ask", description: "ask a human", input: { type: "object" } },
      run: async (_i, ctx) => ({ ok: await ctx.requestInput({ id: "a1", prompt: "ok?" }) }),
    };
    const model = scriptedModel([
      { text: "asking", toolCalls: [{ id: "c1", name: "ask", input: {} }] },
      { text: "one done", toolCalls: [] },
      { text: "asking again", toolCalls: [{ id: "c2", name: "ask", input: {} }] },
      { text: "two done", toolCalls: [] },
    ]);
    const store = new DoSessionStore(await storage());
    const s = new AgentSession("ops", "s", store, new TestBroadcaster(), model, [ask], noRuntime);

    const t1 = s.start({ turnId: "t1", userText: "one" }).turnId;
    expect(await s.result(t1)).toMatchObject({ status: "suspended", request: { id: "a1" } });
    s.resume(t1, "a1", "yes");
    expect(await s.result(t1)).toEqual({ status: "completed", text: "one done" });

    const t2 = s.start({ turnId: "t2", userText: "two" }).turnId;
    expect(await s.result(t2)).toMatchObject({ status: "suspended", request: { id: "a1" } }); // asked again — no leak, no PK crash
    s.resume(t2, "a1", "no");
    expect(await s.result(t2)).toEqual({ status: "completed", text: "two done" });
  });

  test("sseTurnEvents parses the SSE stream into TurnEvents (skipping :hb heartbeats)", async () => {
    const frames =
      ":hb\n\n" +
      `data: ${JSON.stringify({ type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "x" } })}\n\n` +
      ":hb\n\n" +
      `data: ${JSON.stringify({ type: "turn.completed", turnId: "t1", text: "hi" })}\n\n`;
    const res = new Response(frames, { headers: { "content-type": "text/event-stream" } });
    const out: TurnEvent[] = [];
    for await (const e of sseTurnEvents(res)) out.push(e);
    expect(out.map((e) => e.type)).toEqual(["turn.started", "turn.completed"]);
    expect(out.at(-1)).toMatchObject({ type: "turn.completed", text: "hi" });
  });

  test("sseTurnFinalText throws a clear error on a non-SSE / error response", async () => {
    await expect(sseTurnFinalText(Response.json({ error: "boom" }, { status: 500 }))).rejects.toThrow(/expected an SSE response.*status 500/);
  });

  test("POST /turn runs a durable turn; GET /transcript reads the log", async () => {
    const s = await storage();
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] });

    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "Order 3 widgets", turnId: "t1" }) }));
    expect(await sseTurnFinalText(res)).toBe("Done — order placed.");

    const t = await agent.fetch(new Request("https://do/transcript"));
    const { transcript } = (await t.json()) as { transcript: { user: string }[] };
    expect(transcript[0]!.user).toBe("Order 3 widgets");
  });

  test("POST /turn with a proactive trigger logs a `trigger`-role opening in the durable log (P4 §9)", async () => {
    const s = await storage();
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: scriptedModel([{ text: "3 open threads today.", toolCalls: [] }]), tools: [] });

    // the edge body carries `trigger` (serializeTurn forwards it); the DO seeds the turn with it.
    const res = await agent.fetch(new Request("https://do/turn", {
      method: "POST",
      body: JSON.stringify({ userText: "Summarize today's open threads.", turnId: "t1", trigger: { kind: "proactive", by: "cron:daily" } }),
    }));
    expect(await sseTurnFinalText(res)).toBe("3 open threads today.");

    // read the RAW messages (not the fold) to prove the opening is an attributed trigger, not a user msg
    const opening = new DoSessionStore(s).messages()[0]!;
    expect(opening).toEqual({ role: "trigger", turnId: "t1", text: "Summarize today's open threads.", by: "cron:daily" });
  });
});

// ── the DI seam: ambient resources/services reach a tool INSIDE the DO ────────
// A DO is a separate isolate from the Worker entry, so the pipeline's request scope
// never crosses into it. AgentDurableObject instead runs each turn inside a scope
// seeded from the def's resources/services (which the app builds from the DO's env).
// This proves a tool reads ambient `db` + currentServices() with no module-global,
// across turns, and that per-turn `locals` do not leak on a long-lived DO.

// A fake ambient `db` handle (the app would pass `d1(env.DB)`); only query() is used.
function fakeJuneDb(): JuneDb {
  const notUsed = async () => { throw new Error("not used in this test"); };
  return {
    query: (async () => [{ v: "from-do-db" }]) as JuneDb["query"],
    get: notUsed as JuneDb["get"],
    run: notUsed as JuneDb["run"],
    exec: async () => {},
    transaction: (async (fn: (tx: JuneDb) => unknown) => fn(fakeJuneDb())) as JuneDb["transaction"],
    close: async () => {},
    dialect: "sqlite",
  };
}

// An ASYNC tool (⇒ the remote / at-least-once path) that reads everything a real
// retriever/ledger tool would: ambient `db`, the app services bag, and a per-turn
// local. It records what it saw into `seen` so the test can assert reachability.
const PROBE_LOCAL = Symbol("probe-local");
type Probe = { db: string; svc: string; localId: number };
function probeTool(seen: Probe[], nextLocalId: () => number): Tool {
  return {
    spec: { name: "probe", description: "read ambient db + services + a per-turn local", input: { type: "object" } },
    run: async () => {
      const rows = await db.query<{ v: string }>("SELECT 'from-do-db' AS v");
      const svc = currentServices<{ retriever: { fetch(): string } }>();
      const local = requestLocal(PROBE_LOCAL, () => ({ id: nextLocalId() }));
      const obs: Probe = { db: rows[0]!.v, svc: svc?.retriever?.fetch() ?? "no-services", localId: local.id };
      seen.push(obs);
      return obs;
    },
  };
}

// A model that emits ONE probe call per turn with a turn-unique id (so a later turn's
// step can't be skipped by the DO's step cache), then finishes the turn.
function probeModel(): Model {
  return (msgs) => {
    const last = msgs[msgs.length - 1]!;
    if (last.role === "tool") return replyStream({ text: "done", toolCalls: [] });
    const turnId = last.role === "user" ? last.turnId : "t?";
    return replyStream({ text: "probing", toolCalls: [{ id: `probe-${turnId}`, name: "probe", input: {} }] });
  };
}

describe("AgentDurableObject — DI scope (ambient db/services reach a DO tool)", () => {
  test("ambient db + services resolve inside a tool, across turns, with per-turn locals", async () => {
    const s = await storage();
    const seen: Probe[] = [];
    let localIds = 0;
    const agent = new AgentDurableObject(
      { storage: s },
      {
        name: "support",
        model: probeModel(),
        tools: [probeTool(seen, () => ++localIds)],
        resources: { db: fakeJuneDb() },
        services: { retriever: { fetch: () => "retriever-ok" } },
      },
    );

    expect(await agent.turn({ turnId: "t1", userText: "hi" })).toBe("done");
    expect(await agent.turn({ turnId: "t2", userText: "again" })).toBe("done");

    expect(seen).toHaveLength(2);
    // ambient db + services reached the tool on BOTH turns (scope re-entered each turn)…
    expect(seen[0]).toEqual({ db: "from-do-db", svc: "retriever-ok", localId: 1 });
    // …and locals are per-turn: turn 2's local was freshly made (id 2), not turn 1's (id 1).
    expect(seen[1]).toEqual({ db: "from-do-db", svc: "retriever-ok", localId: 2 });
  });

  test("no resources/services declared ⇒ turn still runs (scope is empty, not broken)", async () => {
    const s = await storage();
    // The exactly-once sync tool uses ctx.store.unwrap (not ambient) — it must keep
    // working now that every turn is wrapped in a scope.
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] });
    expect(await agent.turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");
    expect(countOrders(s)).toBe(1);
  });
});

// ── failure observability (#76): a failed turn must never be silent ───────────
// A turn that dies after the fast-ACK has no other observable surface on the edge:
// the webhook already 200'd, and runBackground swallows the rejection unless the
// channel wired onError. The DO therefore console.errors turn.failed by default
// (visible in `wrangler tail`); an app onTurnError hook takes over reporting, and
// a THROWING hook falls back to the default log — nothing goes silent.
describe("AgentDurableObject — turn failure observability (#76)", () => {
  const explodingModel: Model = () => { throw new Error("model exploded (dependency skew)"); };
  const drain = async (res: Response) => { const out: TurnEvent[] = []; for await (const e of sseTurnEvents(res)) out.push(e); return out; };

  test("default: a model failure is console.error'd, and the stream still terminates with turn.failed", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: explodingModel, tools: [] });
      const events = await drain(await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "go", turnId: "t1" }) })));

      // the SSE contract is unchanged: the caller still sees the terminal turn.failed
      expect(events.at(-1)).toMatchObject({ type: "turn.failed", turnId: "t1", error: { message: "model exploded (dependency skew)" } });
      // and the failure is now visible in the DO's own logs (wrangler tail) — with the
      // in-flight step and the real stack trace, not just the flattened message (#96)
      expect(err).toHaveBeenCalledTimes(1);
      const logged = String(err.mock.calls[0]![0]);
      expect(logged).toStartWith('[june] agent "ops" turn t1 failed at model:1: Error: model exploded (dependency skew)');
      expect(logged).toContain("\n    at "); // a stack frame follows
    } finally {
      err.mockRestore();
    }
  });

  test("the direct turn() path logs too (one seam covers every turn path)", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = new AgentDurableObject({ storage: await storage() }, { model: explodingModel, tools: [] });
      await expect(agent.turn({ turnId: "t1", userText: "go" })).rejects.toThrow("model exploded (dependency skew)");
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toStartWith('[june] agent "agent" turn t1 failed at model:1: Error: model exploded (dependency skew)'); // name defaults to "agent"
    } finally {
      err.mockRestore();
    }
  });

  test("onTurnError takes over reporting: hook sees the failure, default log stays quiet", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: { turnId: string; error: { message: string; stack?: string }; phase?: string; step?: string }[] = [];
      const agent = new AgentDurableObject(
        { storage: await storage() },
        { name: "ops", model: explodingModel, tools: [], onTurnError: (f) => { seen.push(f); } },
      );
      const events = await drain(await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "go", turnId: "t1" }) })));

      expect(events.at(-1)).toMatchObject({ type: "turn.failed" });
      // #96: the hook gets the failure serialized at the throw site — stack and the
      // in-flight step included, since for a detached turn this hook is the only surface.
      expect(seen).toMatchObject([{ turnId: "t1", error: { message: "model exploded (dependency skew)" }, phase: "model", step: "model:1" }]);
      expect(seen[0]!.error.stack).toContain("model exploded");
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  test("a THROWING onTurnError falls back to the default log — the failure is never silent", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = new AgentDurableObject(
        { storage: await storage() },
        { name: "ops", model: explodingModel, tools: [], onTurnError: () => { throw new Error("sentry down"); } },
      );
      const events = await drain(await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "go", turnId: "t1" }) })));

      expect(events.at(-1)).toMatchObject({ type: "turn.failed" }); // a broken hook never breaks the stream
      const logged = err.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes("onTurnError hook threw"))).toBe(true);
      expect(logged.some((l) => l.startsWith('[june] agent "ops" turn t1 failed at model:1: Error: model exploded (dependency skew)'))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test("a REJECTING async onTurnError falls back to the default log too — no unhandled rejection", async () => {
    // `(failure) => void` admits an async implementation (Promise is assignable to void);
    // its rejection must hit the same fallback as a sync throw, or the failure goes
    // silent again — the exact hole this feature exists to close.
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = new AgentDurableObject(
        { storage: await storage() },
        { name: "ops", model: explodingModel, tools: [], onTurnError: async () => { throw new Error("sentry down"); } },
      );
      const events = await drain(await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "go", turnId: "t1" }) })));
      await new Promise((r) => setTimeout(r, 0)); // let the rejection's .catch continuation run

      expect(events.at(-1)).toMatchObject({ type: "turn.failed" });
      const logged = err.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes("onTurnError hook rejected"))).toBe(true);
      expect(logged.some((l) => l.startsWith('[june] agent "ops" turn t1 failed at model:1: Error: model exploded (dependency skew)'))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test("a healthy turn logs nothing", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] });
      expect(await agent.turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

// ── session identity (#75): the external session key reaches the turn scope ──
// The DO is keyed by idFromName(`${agent}:${session}`) but cannot read its own
// name, so durableFetch stamps the key on a header; the DO resolves it lazily,
// persists it (survives eviction), and hands it to tools as ctx.sessionId —
// previously the literal "self" for every conversation.
describe("AgentDurableObject — session identity (#75)", () => {
  // records what a tool observes as ctx.sessionId — the exact field #75 corrupted
  function sessionProbeTool(seen: string[]): Tool {
    return {
      spec: { name: "session_probe", description: "read ctx.sessionId", input: { type: "object" } },
      run: (_i, ctx) => { seen.push(ctx.sessionId); return { sid: ctx.sessionId }; },
    };
  }
  // one probe call per turn, with a turn-unique call id so a second turn's step
  // isn't skipped by the exactly-once cache
  const probeModel: Model = (msgs) => {
    const last = msgs[msgs.length - 1]!;
    if (last.role === "tool") return replyStream({ text: "done", toolCalls: [] });
    const turnId = last.role === "user" || last.role === "trigger" ? last.turnId : "t?";
    return replyStream({ text: "probing", toolCalls: [{ id: `sp-${turnId}`, name: "session_probe", input: {} }] });
  };
  const mkAgent = (s: DurableStorage, seen: string[]) =>
    new AgentDurableObject({ storage: s }, { name: "support", model: probeModel, tools: [sessionProbeTool(seen)] });
  const turnReq = (turnId: string, session?: string) =>
    new Request("https://do/turn", {
      method: "POST",
      headers: session ? { [SESSION_HEADER]: session } : undefined,
      body: JSON.stringify({ userText: "hi", turnId }),
    });

  test("durableFetch stamps the key; the DO routes it to ctx.sessionId", async () => {
    const seen: string[] = [];
    const agent = mkAgent(await storage(), seen);
    const captured: { id?: unknown; req?: Request } = {};
    const ns: DurableObjectNamespace = {
      idFromName: (n) => { captured.id = n; return n; },
      get: () => ({ fetch: (req) => { captured.req = req; return agent.fetch(req); } }),
    };

    const res = await durableFetch(ns, "support", "crisp:web1:sess42", new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "hi", turnId: "t1" }) }));
    expect(await sseTurnFinalText(res)).toBe("done");
    expect(captured.id).toBe("support:crisp:web1:sess42");                          // DO addressed by (agent, session)…
    expect(captured.req!.headers.get(SESSION_HEADER)).toBe("crisp:web1:sess42");    // …and the SAME key rode the request
    expect(seen).toEqual(["crisp:web1:sess42"]);                                    // the tool saw the real session, not "self"
  });

  test("the key persists across eviction: a key-less later life still resolves it", async () => {
    const s = await storage();
    const seen: string[] = [];
    expect(await sseTurnFinalText(await mkAgent(s, seen).fetch(turnReq("t1", "crisp:web1:sess42")))).toBe("done");

    // fresh AgentDurableObject over the SAME storage (models DO eviction), no key in hand
    const seen2: string[] = [];
    expect(await mkAgent(s, seen2).turn({ turnId: "t2", userText: "again" })).toBe("done");
    expect(seen2).toEqual(["crisp:web1:sess42"]); // resolved from agent_meta, not "self"
  });

  test("no key anywhere → \"self\" (the pre-#75 fallback, backward compatible)", async () => {
    const seen: string[] = [];
    const agent = mkAgent(await storage(), seen);
    expect(await sseTurnFinalText(await agent.fetch(turnReq("t1")))).toBe("done");
    expect(seen).toEqual(["self"]);
  });

  test("turn({ session }) carries the key on the direct API too", async () => {
    const seen: string[] = [];
    expect(await mkAgent(await storage(), seen).turn({ turnId: "t1", userText: "hi", session: "slack:C1:1.1" })).toBe("done");
    expect(seen).toEqual(["slack:C1:1.1"]);
  });

  test("a key that contradicts this object's identity is a loud 409, not silent corruption", async () => {
    const s = await storage();
    const seen: string[] = [];
    const agent = mkAgent(s, seen);
    expect(await sseTurnFinalText(await agent.fetch(turnReq("t1", "session-a")))).toBe("done");

    // same life: a mis-routed key conflicts with the LIVE session
    const live = await agent.fetch(turnReq("t2", "session-b"));
    expect(live.status).toBe(409);
    expect(((await live.json()) as { error: string }).error).toMatch(/does not match/);

    // later life: the conflict is caught against the PERSISTED key too
    const evicted = await mkAgent(s, []).fetch(turnReq("t3", "session-b"));
    expect(evicted.status).toBe(409);
    expect(seen).toEqual(["session-a"]); // no turn ever ran under the wrong identity
  });

  test("key-less first use commits \"self\"; a keyed request after it refuses to switch", async () => {
    const seen: string[] = [];
    const agent = mkAgent(await storage(), seen);
    expect(await agent.turn({ turnId: "t1", userText: "hi" })).toBe("done"); // legacy path, id = "self"
    const res = await agent.fetch(turnReq("t2", "crisp:web1:sess42"));
    expect(res.status).toBe(409); // prior turns already recorded "self" — never silently switch identity
  });

  test("…but after eviction a keyed request ADOPTS a legacy \"self\" transcript (the migration path)", async () => {
    // "self" is a placeholder, not an identity — it is deliberately never persisted.
    // Same-life keyed-after-key-less is refused (two live paths disagreeing is a bug,
    // above); across eviction the keyed request adopts and binds the real identity.
    // Persisting "self" instead would 409 every keyed request to a pre-#75 DO forever.
    const s = await storage();
    expect(await mkAgent(s, []).turn({ turnId: "t1", userText: "hi" })).toBe("done"); // legacy life, id = "self"

    const seen: string[] = [];
    const adopted = mkAgent(s, seen); // fresh life over the SAME storage
    expect(await sseTurnFinalText(await adopted.fetch(turnReq("t2", "crisp:web1:sess42")))).toBe("done");
    expect(seen).toEqual(["crisp:web1:sess42"]); // the keyed request bound the real identity…

    const seen2: string[] = [];
    expect(await mkAgent(s, seen2).turn({ turnId: "t3", userText: "again" })).toBe("done");
    expect(seen2).toEqual(["crisp:web1:sess42"]); // …and it persisted: a key-less later life resolves it
  });

  test("/resume carries the key across eviction; a wrong key 409s", async () => {
    const s = await storage();
    const approve: Tool = {
      spec: { name: "approve", description: "ask a human", input: { type: "object" } },
      run: async (_i, ctx) => ({ approved: await ctx.requestInput({ id: "a1", prompt: "ok?" }) }),
    };
    const model = scriptedModel([
      { text: "asking", toolCalls: [{ id: "c1", name: "approve", input: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const mk = () => new AgentDurableObject({ storage: s }, { name: "support", model, tools: [approve] });
    const event = { source: "slack", kind: "message", channelId: "C1", ts: "1.1", user: { id: "U1" } };

    const parked = await mk().fetch(new Request("https://do/turn", {
      method: "POST",
      headers: { [SESSION_HEADER]: "slack:C1:1.1" },
      body: JSON.stringify({ userText: "refund", turnId: "t1", event }),
    }));
    for await (const _ of sseTurnEvents(parked)) { /* drain to the park */ }

    // fresh life (eviction while suspended); resume with the WRONG key must not touch the turn
    const resumeReq = (session: string) => new Request("https://do/resume", {
      method: "POST",
      headers: { [SESSION_HEADER]: session },
      body: JSON.stringify({ turnId: "t1", inputId: "a1", input: true, by: "U1" }),
    });
    expect((await mk().fetch(resumeReq("slack:WRONG:9.9"))).status).toBe(409);

    const ok = await mk().fetch(resumeReq("slack:C1:1.1"));
    const events: TurnEvent[] = [];
    for await (const e of sseTurnEvents(ok)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "done" });
  });

  test("an explicit \"self\" stays a placeholder — never persisted, so a real key still adopts after eviction", async () => {
    const s = await storage();
    const seen: string[] = [];
    expect(await sseTurnFinalText(await mkAgent(s, seen).fetch(turnReq("t1", "self")))).toBe("done");
    expect(seen).toEqual(["self"]); // explicit "self" binds the live placeholder like a key-less call

    const seen2: string[] = [];
    expect(await sseTurnFinalText(await mkAgent(s, seen2).fetch(turnReq("t2", "crisp:web1:sess42")))).toBe("done");
    expect(seen2).toEqual(["crisp:web1:sess42"]); // NOT stuck on "self": the placeholder never persisted
  });

  test("durableFetch refuses a session key that can't ride the header — clear error, not a deep TypeError", () => {
    const ns: DurableObjectNamespace = { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("unreached") }) };
    const req = () => new Request("https://do/turn", { method: "POST", body: "{}" });
    expect(() => durableFetch(ns, "support", "bad\r\nx-evil: 1", req())).toThrow(/invalid session key/); // header injection
    expect(() => durableFetch(ns, "support", "訪客-42", req())).toThrow(/invalid session key/);          // non-ASCII: Headers.set would TypeError
    expect(() => durableFetch(ns, "support", "", req())).toThrow(/invalid session key/);                 // empty
    expect(() => durableFetch(ns, "support", "crisp:web1:sess42", req())).not.toThrow();
  });

  test("turn({ session }) enforces the same key contract — an invalid key never binds or persists", async () => {
    const s = await storage();
    const seen: string[] = [];
    const agent = mkAgent(s, seen);
    await expect(agent.turn({ turnId: "t1", userText: "hi", session: "bad\r\nkey" })).rejects.toThrow(/invalid session key/);
    await expect(agent.turn({ turnId: "t1", userText: "hi", session: "訪客-42" })).rejects.toThrow(/invalid session key/);
    // nothing was bound or persisted — the object is still addressable by a real key
    expect(await sseTurnFinalText(await agent.fetch(turnReq("t2", "crisp:web1:sess42")))).toBe("done");
    expect(seen).toEqual(["crisp:web1:sess42"]);
  });

  test("the chat surface 400s an un-headerable client session — a bad request, not a 500", async () => {
    const agent = mkAgent(await storage(), []);
    const ns: DurableObjectNamespace = { idFromName: (n) => n, get: () => ({ fetch: (req) => agent.fetch(req) }) };
    const surface = durableAgentSurface(() => ns, { agentName: "support", chatPath: "/message" });
    const res = await surface(new Request("https://edge/message", { method: "POST", body: JSON.stringify({ message: "hi", session: "bad\r\nkey" }) }));
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as { error: string }).error).toMatch(/invalid session key/);
  });

  test("a transcript read on a later life binds the PERSISTED identity — cached, and still conflict-checked", async () => {
    const s = await storage();
    expect(await sseTurnFinalText(await mkAgent(s, []).fetch(turnReq("t1", "crisp:web1:sess42")))).toBe("done");

    const agent = mkAgent(s, []); // fresh life; identity is already persisted, so a read may bind it
    expect(agent.transcript().length).toBeGreaterThan(0);
    expect((await agent.fetch(turnReq("t2", "other-session"))).status).toBe(409);   // bound identity still guards
    expect(await sseTurnFinalText(await agent.fetch(turnReq("t3", "crisp:web1:sess42")))).toBe("done"); // same key proceeds
  });

  test("a key-less transcript read stays non-committal: a later keyed turn still binds the identity", async () => {
    const seen: string[] = [];
    const agent = mkAgent(await storage(), seen);
    expect(agent.transcript()).toEqual([]); // read BEFORE any key exists — must not commit "self"
    expect(await sseTurnFinalText(await agent.fetch(turnReq("t1", "crisp:web1:sess42")))).toBe("done");
    expect(seen).toEqual(["crisp:web1:sess42"]);
  });
});

// ── fire-and-forget turns (#77): detached execution under the DO's own lifetime ──
// Holding the caller open for the whole turn bounds turn duration by the CALLER's
// lifetime — on the edge, the worker's post-ACK waitUntil ceiling killed 24–38s
// shadow turns in production. Detach: the DO 202s once the turn is durably accepted
// and keeps running it itself; nobody consumes the result, so failures surface via
// the #76 default log / onTurnError.
describe("AgentDurableObject — detached turns (#77)", () => {
  // a model whose reply is gated: the test controls exactly when the turn can finish
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model: Model = () => (async function* () {
      await gate;
      yield { type: "done" as const, reply: { text: "done late", toolCalls: [] } };
    })();
    return { model, release };
  };
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(pred()).toBe(true);
  };
  const detachReq = (turnId: string, session = "k1") =>
    new Request("https://do/turn?detach=1", {
      method: "POST",
      headers: { [SESSION_HEADER]: session },
      body: JSON.stringify({ userText: "go", turnId }),
    });

  test("/turn?detach=1 202s on acceptance; the turn completes under the DO's own lifetime", async () => {
    const { model, release } = gated();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [] });

    const res = await agent.fetch(detachReq("t1"));
    expect(res.status).toBe(202);                                    // accepted BEFORE the model replied…
    expect(await res.json()).toEqual({ turnId: "t1" });
    expect(agent.transcript().find((t) => t.turnId === "t1")?.text).toBeUndefined(); // …turn still in flight

    release();
    await until(() => agent.transcript().find((t) => t.turnId === "t1")?.text === "done late");
  });

  test("a detached turn that fails is 202-then-logged — the #76 seam is its only surface", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const exploding: Model = () => { throw new Error("model exploded (detached)"); };
      const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: exploding, tools: [] });
      const res = await agent.fetch(detachReq("t1"));
      expect(res.status).toBe(202); // acceptance is not completion — the failure happens after
      await until(() => err.mock.calls.some((c) => String(c[0]).includes('turn t1 failed at model:1: Error: model exploded (detached)')));
    } finally {
      err.mockRestore();
    }
  });

  test("detach preserves the conflict contract: a parked session still 409s", async () => {
    const ask: Tool = {
      spec: { name: "ask", description: "ask a human", input: { type: "object" } },
      run: async (_i, ctx) => ({ ok: await ctx.requestInput({ id: "a1", prompt: "ok?" }) }),
    };
    const model = scriptedModel([
      { text: "asking", toolCalls: [{ id: "c1", name: "ask", input: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [ask] });
    const parked = await agent.fetch(new Request("https://do/turn", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ userText: "go", turnId: "t1" }) }));
    for await (const _ of sseTurnEvents(parked)) { /* drain to the park */ }
    expect((await agent.fetch(detachReq("t2"))).status).toBe(409);
  });

  test("durableChannelSurface.runDetached: ?detach=1 on the wire, 202 back, completion later", async () => {
    const { model, release } = gated();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [] });
    const seenUrls: string[] = [];
    const ns: DurableObjectNamespace = {
      idFromName: (n) => n,
      get: () => ({ fetch: (req) => { seenUrls.push(req.url); return agent.fetch(req); } }),
    };
    // a shadow channel: its webhook fires an assessment turn and drops the reply —
    // exactly the observe-mode pattern the edge ceiling used to kill
    const shadow = defineChannel({
      name: "shadow",
      path: "/hooks/shadow",
      webhook: async (_req, ctx) => Response.json(await ctx.runDetached!("assess this", { session: "crisp:web1:s1", turnId: "t1" }), { status: 202 }),
    });
    const surface = durableChannelSurface(() => ns, { agentName: "ops", channels: [shadow], env: {} });

    const res = await surface(new Request("https://edge/hooks/shadow", { method: "POST" }));
    expect(res!.status).toBe(202);
    expect(await res!.json()).toEqual({ turnId: "t1" });
    expect(seenUrls[0]).toContain("detach=1");

    release();
    await until(() => agent.transcript().find((t) => t.turnId === "t1")?.text === "done late");
  });

  test("mountAgent exposes the same seam natively — a channel ports without changes", async () => {
    const rt = await createAgentRuntime({ ops: { model: scriptedModel([{ text: "done", toolCalls: [] }]), tools: [] } }, { backend: "memory" });
    const def = { name: "ops", instructions: "", tools: [], skills: [], channels: [], connections: [] } satisfies AgentDefinition;
    const { ctx } = mountAgent(def, rt);
    expect(await ctx.runDetached!("go", { session: "s1", turnId: "t1" })).toEqual({ turnId: "t1" });
    expect(await rt.session("ops", "s1").result("t1")).toEqual({ status: "completed", text: "done" });
  });

  test("start() on the direct API: accepted now, running after", async () => {
    const { model, release } = gated();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [] });
    expect(await agent.start({ turnId: "t1", userText: "go", session: "k1" })).toEqual({ turnId: "t1" });
    release();
    await until(() => agent.transcript().find((t) => t.turnId === "t1")?.text === "done late");
  });
});

// ── delivered turns: detach's reply-bearing sibling — the DO renders the reply itself ──
// A reply-bearing turn rendered by the CALLER dies with the caller (the edge waitUntil
// ceiling cancelled a >30s Slack Q&A turn in production — silently: cancellation is not an
// exception, so no failure path ever ran and nothing posted). deliver=1: the DO 202s on
// acceptance and renders the turn's event stream through the source channel's own deliver()
// under its OWN lifetime.
describe("AgentDurableObject — delivered turns", () => {
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model: Model = () => (async function* () {
      await gate;
      yield { type: "done" as const, reply: { text: "delivered late", toolCalls: [] } };
    })();
    return { model, release };
  };
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(pred()).toBe(true);
  };
  const mention: InboundEvent = { source: "slackish", kind: "app_mention", channelId: "C1", threadId: "111.1", teamId: "T9", ts: "111.1", user: { id: "U1" }, text: "status?" };
  const deliverReq = (turnId: string, event: InboundEvent | undefined = mention, session = "k1") =>
    new Request("https://do/turn?deliver=1", {
      method: "POST",
      headers: { [SESSION_HEADER]: session },
      body: JSON.stringify({ userText: "go", turnId, event }),
    });
  // a channel whose deliver() records what the DO hands it — target, session, event stream
  const recordingChannel = () => {
    const seen: { target?: unknown; session?: string; events: TurnEvent[]; done: boolean } = { events: [], done: false };
    const channel = defineChannel({
      name: "slackish",
      path: "/x",
      deliver: async (target, events, o) => {
        seen.target = target;
        seen.session = o?.session;
        for await (const e of events) seen.events.push(e);
        seen.done = true;
      },
    });
    return { seen, channel };
  };

  test("/turn?deliver=1 202s on acceptance; the DO renders the full event stream through channel.deliver()", async () => {
    const { model, release } = gated();
    const { seen, channel } = recordingChannel();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [], channels: [channel] });

    const res = await agent.fetch(deliverReq("t1"));
    expect(res.status).toBe(202);                       // accepted BEFORE the model replied…
    expect(await res.json()).toEqual({ turnId: "t1" });
    expect(seen.done).toBe(false);                      // …and the render is still consuming

    release();
    await until(() => seen.done);
    // the reply target is the inbound event's author/thread — exactly renderStream's surface
    expect(seen.target).toEqual({ channelId: "C1", threadId: "111.1", recipientUserId: "U1", recipientTeamId: "T9" });
    expect(seen.session).toBe("k1");
    expect(seen.events.map((e) => e.type)).toEqual(["turn.started", "message.completed", "turn.completed"]);
    expect(seen.events.at(-1)).toMatchObject({ type: "turn.completed", text: "delivered late" });
  });

  test("no deliver()-capable channel for event.source → 501 BEFORE the turn starts (the safe-fallback contract)", async () => {
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: gated().model, tools: [] }); // no channels wired
    const res = await agent.fetch(deliverReq("t1"));
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain("the turn was NOT started");
    expect(agent.transcript()).toHaveLength(0);         // nothing ran — a caller may re-run safely
  });

  test("deliver=1 without an inbound event is a 400 — there is no reply target to derive", async () => {
    const { channel } = recordingChannel();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: gated().model, tools: [], channels: [channel] });
    const eventless = new Request("https://do/turn?deliver=1", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ userText: "go", turnId: "t1" }) });
    expect((await agent.fetch(eventless)).status).toBe(400);
    expect(agent.transcript()).toHaveLength(0);
  });

  test("a delivered render failure is logged — the turn itself is unaffected", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const exploding = defineChannel({ name: "slackish", path: "/x", deliver: async () => { throw new Error("platform down"); } });
      const model: Model = () => replyStream({ text: "fine", toolCalls: [] });
      const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [], channels: [exploding] });
      expect((await agent.fetch(deliverReq("t1"))).status).toBe(202);
      await until(() => err.mock.calls.some((c) => String(c[0]).includes("delivered render for turn t1 failed")));
      await until(() => agent.transcript().find((t) => t.turnId === "t1")?.text === "fine"); // the TURN completed durably
    } finally {
      err.mockRestore();
    }
  });

  test("a SYNCHRONOUSLY-throwing deliver() still 202s and logs — never a 500 for a turn that runs anyway", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      // throws before ever returning a promise — the sharpest shape of app/third-party code
      const explodingSync = defineChannel({ name: "slackish", path: "/x", deliver: (() => { throw new Error("sync boom"); }) as unknown as Channel["deliver"] });
      const model: Model = () => replyStream({ text: "fine", toolCalls: [] });
      const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [], channels: [explodingSync] });
      expect((await agent.fetch(deliverReq("t1"))).status).toBe(202); // acceptance stands
      await until(() => err.mock.calls.some((c) => String(c[0]).includes("delivered render for turn t1 failed")));
      await until(() => agent.transcript().find((t) => t.turnId === "t1")?.text === "fine"); // the TURN completed durably
    } finally {
      err.mockRestore();
    }
  });

  test("durableChannelSurface.runDelivered: deliver=1 on the wire; a 501 maps to DeliverUnsupportedError", async () => {
    const { model, release } = gated();
    const { seen, channel } = recordingChannel();
    const withChannel = new AgentDurableObject({ storage: await storage() }, { name: "ops", model, tools: [], channels: [channel] });
    const without = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: gated().model, tools: [] });
    const seenUrls: string[] = [];
    const nsFor = (agent: AgentDurableObject): DurableObjectNamespace => ({
      idFromName: (n) => n,
      get: () => ({ fetch: (req) => { seenUrls.push(req.url); return agent.fetch(req); } }),
    });
    // a webhook that runs a delivered turn and reports which path it took
    const hook = defineChannel({
      name: "slackish",
      path: "/hooks/x",
      webhook: async (_req, ctx) => {
        try {
          return Response.json(await ctx.runDelivered!("go", { session: "k1", turnId: "t1", event: mention }), { status: 202 });
        } catch (e) {
          return Response.json({ unsupported: e instanceof DeliverUnsupportedError }, { status: 501 });
        }
      },
    });

    const ok = await durableChannelSurface(() => nsFor(withChannel), { agentName: "ops", channels: [hook], env: {} })(new Request("https://edge/hooks/x", { method: "POST" }));
    expect(ok!.status).toBe(202);
    expect(await ok!.json()).toEqual({ turnId: "t1" });
    expect(seenUrls[0]).toContain("deliver=1");
    release();
    await until(() => seen.done);

    const refused = await durableChannelSurface(() => nsFor(without), { agentName: "ops", channels: [hook], env: {} })(new Request("https://edge/hooks/x", { method: "POST" }));
    expect(refused!.status).toBe(501);
    expect(await refused!.json()).toEqual({ unsupported: true }); // the typed error crossed the surface
  });
});

// ── delivered resume: the HITL continuation leg of delivered turns ─────────────
// A resumed continuation rendered by the CALLER dies with the caller (the same edge
// waitUntil ceiling — worse UX: the prompt is already stuck on "_Working…_").
// deliver=1 on /resume: the DO applies the answer, 202s, and renders the continuation
// through the source channel's deliverResume() under its OWN lifetime.
describe("AgentDurableObject — delivered resume", () => {
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(pred()).toBe(true);
  };
  const ask: Tool = {
    spec: { name: "ask", description: "ask a human", input: { type: "object" } },
    run: async (_i, ctx) => ({ ok: await ctx.requestInput({ id: "a1", prompt: "ok?" }) }),
  };
  const askModel = () =>
    scriptedModel([
      { text: "asking", toolCalls: [{ id: "c1", name: "ask", input: {} }] },
      { text: "done after approval", toolCalls: [] },
    ]);
  const TARGET = { channelId: "C1", threadId: "5.5", messageTs: "9.9" };
  const recordingResumeChannel = () => {
    const seen: { target?: unknown; session?: string; events: TurnEvent[]; done: boolean } = { events: [], done: false };
    const channel = defineChannel({
      name: "slackish",
      path: "/x",
      deliverResume: async (target, events, o) => {
        seen.target = target;
        seen.session = o?.session;
        for await (const e of events) seen.events.push(e);
        seen.done = true;
      },
    });
    return { seen, channel };
  };
  const park = async (agent: AgentDurableObject) => {
    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ userText: "please", turnId: "t1" }) }));
    for await (const _ of sseTurnEvents(res)) void _; // drain to the park
  };
  const resumeReq = (extra: Record<string, unknown> = {}) =>
    new Request("https://do/resume?deliver=1", {
      method: "POST",
      headers: { [SESSION_HEADER]: "k1" },
      body: JSON.stringify({ turnId: "t1", inputId: "a1", input: true, source: "slackish", target: TARGET, ...extra }),
    });

  test("/resume?deliver=1 202s; the continuation renders through deliverResume", async () => {
    const { seen, channel } = recordingResumeChannel();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: askModel(), tools: [ask], channels: [channel] });
    await park(agent);

    const res = await agent.fetch(resumeReq());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ turnId: "t1" });

    await until(() => seen.done);
    expect(seen.target).toEqual(TARGET);
    expect(seen.session).toBe("k1");
    expect(seen.events.at(-1)).toMatchObject({ type: "turn.completed", text: "done after approval" });
  });

  test("no deliverResume-capable channel → 501 BEFORE the answer applies; a plain /resume afterwards still succeeds", async () => {
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: askModel(), tools: [ask] }); // no channels wired
    await park(agent);

    const refused = await agent.fetch(resumeReq());
    expect(refused.status).toBe(501);
    expect(((await refused.json()) as { error: string }).error).toContain("the answer was NOT applied");

    // the turn is STILL parked — the ordinary resume path completes it
    const plain = await agent.fetch(new Request("https://do/resume", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ turnId: "t1", inputId: "a1", input: true }) }));
    const events: TurnEvent[] = [];
    for await (const e of sseTurnEvents(plain)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "done after approval" });
  });

  test("deliver=1 without source/target is a 400 — nothing applied", async () => {
    const { channel } = recordingResumeChannel();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: askModel(), tools: [ask], channels: [channel] });
    await park(agent);
    const res = await agent.fetch(new Request("https://do/resume?deliver=1", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ turnId: "t1", inputId: "a1", input: true }) }));
    expect(res.status).toBe(400);
  });

  test("an engine rejection (not suspended) 409s and deliverResume never runs", async () => {
    const { seen, channel } = recordingResumeChannel();
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: scriptedModel([{ text: "done", toolCalls: [] }]), tools: [], channels: [channel] });
    // complete a turn normally — nothing is parked
    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", headers: { [SESSION_HEADER]: "k1" }, body: JSON.stringify({ userText: "go", turnId: "t1" }) }));
    for await (const _ of sseTurnEvents(res)) void _;

    expect((await agent.fetch(resumeReq())).status).toBe(409);
    expect(seen.done).toBe(false);
    expect(seen.events).toHaveLength(0);
  });

  test("durableChannelSurface.resumeDelivered: deliver=1 on the wire; a 501 maps to DeliverUnsupportedError", async () => {
    const { seen, channel } = recordingResumeChannel();
    const withChannel = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: askModel(), tools: [ask], channels: [channel] });
    const without = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: askModel(), tools: [ask] });
    await park(withChannel);
    await park(without);
    const seenUrls: string[] = [];
    const nsFor = (agent: AgentDurableObject): DurableObjectNamespace => ({
      idFromName: (n) => n,
      get: () => ({ fetch: (req) => { seenUrls.push(req.url); return agent.fetch(req); } }),
    });
    const hook = defineChannel({
      name: "slackish",
      path: "/hooks/x",
      webhook: async (_req, ctx) => {
        try {
          return Response.json(await ctx.resumeDelivered!({ session: "k1", turnId: "t1", inputId: "a1", input: true, source: "slackish", target: TARGET }), { status: 202 });
        } catch (e) {
          return Response.json({ unsupported: e instanceof DeliverUnsupportedError }, { status: 501 });
        }
      },
    });

    const ok = await durableChannelSurface(() => nsFor(withChannel), { agentName: "ops", channels: [hook], env: {} })(new Request("https://edge/hooks/x", { method: "POST" }));
    expect(ok!.status).toBe(202);
    expect(await ok!.json()).toEqual({ turnId: "t1" });
    expect(seenUrls[0]).toContain("deliver=1");
    await until(() => seen.done);

    const refused = await durableChannelSurface(() => nsFor(without), { agentName: "ops", channels: [hook], env: {} })(new Request("https://edge/hooks/x", { method: "POST" }));
    expect(refused!.status).toBe(501);
    expect(await refused!.json()).toEqual({ unsupported: true }); // the typed error crossed the surface
  });
});

describe("createAgentRuntime — backend selection", () => {
  test("memory backend runs a durable turn (ephemeral)", async () => {
    // memory has no SQL handle, so use a pure tool (no unwrap): durable side
    // effects are for the native / DO backends.
    const pureOrder: Tool = {
      spec: { name: "create_order", description: "Place an order", input: { type: "object" } },
      run: (input: { item: string; qty: number }) => ({ orderId: 1, item: input.item, qty: input.qty }),
    };
    const rt = await createAgentRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [pureOrder] } }, { backend: "memory" });
    expect(await rt.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");
  });

  test("durable backend is not an in-process runtime — it throws with guidance", async () => {
    await expect(createAgentRuntime({}, { backend: "durable" })).rejects.toThrow(/Durable Object target/);
  });
});

// ── turn control (#129): cancel-and-replace + session reset across the DO seam ─
describe("AgentDurableObject — turn control (#129)", () => {
  const collect = async (res: Response) => { const out: TurnEvent[] = []; for await (const e of sseTurnEvents(res)) out.push(e); return out; };
  // First call dribbles deltas (yielding between them so a replace can land mid-stream);
  // later calls answer immediately.
  const dribbleThenAnswer = (): Model => {
    let calls = 0;
    return () => {
      const n = ++calls;
      return (async function* (): AsyncGenerator<ModelDelta> {
        if (n === 1) {
          for (let i = 0; i < 1000; i++) {
            yield { type: "text", text: "…" };
            await new Promise((r) => setTimeout(r, 1));
          }
        }
        yield { type: "done", reply: { text: n === 1 ? "stale" : "fresh", toolCalls: [] } };
      })();
    };
  };

  test("POST /turn?replace=1 supersedes the in-flight turn; its stream ends with turn.cancelled", async () => {
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: dribbleThenAnswer(), tools: [] });
    const firstEvents = agent
      .fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "old question", turnId: "t1" }) }))
      .then(collect);
    await new Promise((r) => setTimeout(r, 15)); // let t1 stream a few deltas
    const second = await agent.fetch(new Request("https://do/turn?replace=1", { method: "POST", body: JSON.stringify({ userText: "corrected question", turnId: "t2" }) }));
    expect((await collect(second)).at(-1)).toMatchObject({ type: "turn.completed", text: "fresh" });
    expect((await firstEvents).at(-1)).toEqual({ type: "turn.cancelled", turnId: "t1", reason: "replaced" }); // the SSE terminal — not a hang, not a failure
  });

  test("POST /reset retires the history: audit handle out, live log empty, archive rows kept", async () => {
    const s = await storage();
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: scriptedModel([{ text: "hello!", toolCalls: [] }]), tools: [] });
    const post = (path: string, body?: unknown) =>
      agent.fetch(new Request(`https://do${path}`, { method: "POST", headers: { [SESSION_HEADER]: "k1" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

    expect(await sseTurnFinalText(await post("/turn", { userText: "hi", turnId: "t1" }))).toBe("hello!");
    const reset = await post("/reset");
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ previousSession: "k1#g0", generation: 0 });
    // live log empty; the audit trail holds the retired transcript
    const tr = (await (await agent.fetch(new Request("https://do/transcript", { headers: { [SESSION_HEADER]: "k1" } }))).json()) as { transcript: unknown[] };
    expect(tr.transcript).toEqual([]);
    expect(Number(s.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_messages_archive").one().n)).toBeGreaterThan(0);
    // the ADDRESS survives its history: the same key keeps working, generations count up
    expect(await sseTurnFinalText(await post("/turn", { userText: "again", turnId: "t2" }))).toBe("hello!");
    expect(await (await post("/reset")).json()).toEqual({ previousSession: "k1#g1", generation: 1 });
  });

  test("durableChannelSurface: replace rides the wire as replace=1; resetSession hits /reset", async () => {
    const agent = new AgentDurableObject({ storage: await storage() }, { name: "ops", model: scriptedModel([{ text: "ok", toolCalls: [] }]), tools: [] });
    const seenUrls: string[] = [];
    const ns: DurableObjectNamespace = {
      idFromName: (n) => n,
      get: () => ({ fetch: (req) => { seenUrls.push(req.url); return agent.fetch(req); } }),
    };
    const hook = defineChannel({
      name: "x",
      path: "/hooks/x",
      webhook: async (_req, ctx) => {
        await ctx.run("go", { session: "k1", turnId: "t1", replace: true });
        return Response.json(await ctx.resetSession!({ session: "k1" }));
      },
    });
    const res = await durableChannelSurface(() => ns, { agentName: "ops", channels: [hook], env: {} })(new Request("https://edge/hooks/x", { method: "POST" }));
    expect(await res!.json()).toEqual({ previousSession: "k1#g0", generation: 0 });
    expect(seenUrls[0]).toContain("replace=1");
    expect(seenUrls[1]).toContain("/reset");
  });
});
