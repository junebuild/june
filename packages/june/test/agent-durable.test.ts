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
import { openLocalSqliteSync } from "../src/sqlite-driver";

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
