// The Durable Object edge seam, proven WITHOUT workerd: a fake SqlStorage backed
// by the same synchronous SQLite the DO would use (ctx.storage.sql is synchronous
// too), so the DoSessionStore durability contract runs under bun:test. Reusing
// one fake storage across two DoSessionStores models DO hibernation/eviction —
// storage persists, in-process state is gone. Also drives AgentDurableObject end
// to end and checks the backend selector.

import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentSession,
  type Broadcaster,
  type Model,
  type ModelReply,
  type Runtime,
  type Tool,
} from "@junejs/core/agent-runtime";
import {
  AgentDurableObject,
  DoSessionStore,
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

class TestBroadcaster implements Broadcaster {
  publish() {}
  subscribe() { return () => {}; }
}
const noRuntime: Runtime = { session() { throw new Error("no subagents"); } };

function scriptedModel(script: ModelReply[]): Model {
  return async (msgs) => script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!;
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
    expect(await res.json()).toEqual({ text: "done" }); // dispatched channel_ping (not "unknown tool")
    expect(sawEnv).toEqual({ BOT: "xoxb" });            // channel tools were resolved with the DO env
  });

  test("POST /turn runs a durable turn; GET /transcript reads the log", async () => {
    const s = await storage();
    const agent = new AgentDurableObject({ storage: s }, { name: "ops", model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] });

    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "Order 3 widgets", turnId: "t1" }) }));
    expect(await res.json()).toEqual({ text: "Done — order placed." });

    const t = await agent.fetch(new Request("https://do/transcript"));
    const { transcript } = (await t.json()) as { transcript: { user: string }[] };
    expect(transcript[0]!.user).toBe("Order 3 widgets");
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
  return async (msgs): Promise<ModelReply> => {
    const last = msgs[msgs.length - 1]!;
    if (last.role === "tool") return { text: "done", toolCalls: [] };
    const turnId = last.role === "user" ? last.turnId : "t?";
    return { text: "probing", toolCalls: [{ id: `probe-${turnId}`, name: "probe", input: {} }] };
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
