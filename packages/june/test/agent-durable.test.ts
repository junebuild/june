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
  type Model,
  type ModelReply,
  type Runtime,
  type Tool,
  type TurnEvent,
} from "@junejs/core/agent-runtime";
import {
  AgentDurableObject,
  DoSessionStore,
  sseTurnFinalText,
  sseTurnEvents,
  type DurableStorage,
  type SqlStorage,
} from "../src/agent-durable";
import { createAgentRuntime } from "../src/agent-native";
import { defineChannel } from "@junejs/core/agent-config";
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
      // and the failure is now visible in the DO's own logs (wrangler tail)
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]![0]).toBe('[june] agent "ops" turn t1 failed: model exploded (dependency skew)');
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
      expect(err.mock.calls[0]![0]).toBe('[june] agent "agent" turn t1 failed: model exploded (dependency skew)'); // name defaults to "agent"
    } finally {
      err.mockRestore();
    }
  });

  test("onTurnError takes over reporting: hook sees the failure, default log stays quiet", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: { turnId: string; error: { message: string } }[] = [];
      const agent = new AgentDurableObject(
        { storage: await storage() },
        { name: "ops", model: explodingModel, tools: [], onTurnError: (f) => seen.push(f) },
      );
      const events = await drain(await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "go", turnId: "t1" }) })));

      expect(events.at(-1)).toMatchObject({ type: "turn.failed" });
      expect(seen).toEqual([{ turnId: "t1", error: { message: "model exploded (dependency skew)" } }]);
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
      expect(logged).toContain('[june] agent "ops" turn t1 failed: model exploded (dependency skew)');
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
