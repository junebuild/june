// The native SessionStore seam + the durability contract on a REAL SQLite file:
// a side effect that commits, a crash, then a genuinely fresh NativeRuntime over
// the same file that resumes — proving exactly-once across loss of all in-process
// state (what an in-memory store can't show). The engine logic itself is covered
// in @junejs/core's agent-runtime test.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model, ModelReply, Tool } from "@junejs/core/agent-runtime";
import { replyStream } from "@junejs/core/agent-runtime";
import { createNativeRuntime, NativeRuntime, type AgentDef } from "../src/agent-native";
import { openLocalSqliteSync, type SyncSqlite } from "../src/sqlite-driver";

function scriptedModel(script: ModelReply[]): Model {
  return (msgs) => replyStream(script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!);
}

const ORDER_SCRIPT: ModelReply[] = [
  { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
  { text: "Done — order placed.", toolCalls: [] },
];

// A LOCAL tool: writes an app table via the store's sync handle, in the SAME tx as
// the checkpoint → exactly-once. Counts real executions (skipped replays don't).
function createOrderTool(runs?: { n: number }): Tool {
  return {
    spec: { name: "create_order", description: "Place an order", input: { type: "object" } },
    run: (input: { item: string; qty: number }, ctx) => {
      if (runs) runs.n++;
      const db = ctx.store.unwrap<SyncSqlite>();
      db.exec(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, item TEXT, qty INTEGER)`);
      db.query("INSERT INTO orders (session_id, item, qty) VALUES (?, ?, ?)").run(ctx.sessionId, input.item, input.qty);
      const id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      return { orderId: id, item: input.item, qty: input.qty };
    },
  };
}

async function countOrders(path: string): Promise<number> {
  const db = await openLocalSqliteSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, item TEXT, qty INTEGER)`);
  const n = (db.query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
  db.close();
  return n;
}

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "june-agent-native-"));
  dirs.push(dir);
  return join(dir, "agent.db");
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("agent-native (native SessionStore seam)", () => {
  test("a durable turn runs the loop to completion over real SQLite", async () => {
    const rt = await createNativeRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const answer = await rt.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(answer).toBe("Done — order placed.");
    const turn = rt.session("ops", "s1").transcript()[0]!;
    expect(turn.steps).toEqual([{ name: "create_order", done: true, result: { orderId: 1, item: "widget", qty: 3 } }]);
    expect(rt.session("ops", "s1").snapshot().status).toBe("done");
  });

  test("local side effect is exactly-once across a crash + a fresh runtime over the same file", async () => {
    const path = tmpDbPath();
    const runs = { n: 0 };
    const def: AgentDef = { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool(runs)] };

    // Run 1: crash right AFTER the tool tx commits (side effect + checkpoint durable).
    const rt1 = await createNativeRuntime({ ops: def }, path);
    await expect(
      rt1.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets", crash: { at: "after-tool-commit", step: "tool:c1" } }),
    ).rejects.toThrow(/CRASH after-tool-commit/);
    expect(await countOrders(path)).toBe(1);

    // Run 2: a BRAND NEW runtime over the same file — no in-process state carries
    // over; resume is rebuilt purely from the persisted log + steps.
    const rt2 = await createNativeRuntime({ ops: def }, path);
    const answer = await rt2.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(answer).toBe("Done — order placed.");
    expect(await countOrders(path)).toBe(1); // still one — the committed step was skipped, not re-run
    expect(runs.n).toBe(1); // the tool executed once total, never on replay
  });

  test("checkpoint keys are session-scoped — two sessions with identical step ids don't collide", async () => {
    const rt = await createNativeRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } });
    const a = await rt.session("ops", "alice").turn({ turnId: "t1", userText: "Order 3 widgets" });
    const b = await rt.session("ops", "bob").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(a).toBe("Done — order placed.");
    expect(b).toBe("Done — order placed.");
    expect(rt.session("ops", "alice").transcript()).toHaveLength(1);
    expect(rt.session("ops", "bob").transcript()).toHaveLength(1);
  });

  test("instructions on the AgentDef reach the model as the system prompt (per turn)", async () => {
    let seenSystem: string | undefined;
    const captureModel: Model = (_msgs, _tools, opts) => {
      seenSystem = opts?.system;
      return replyStream({ text: "ok", toolCalls: [] });
    };
    const def: AgentDef = { model: captureModel, tools: [], instructions: "You are the ops assistant." };
    const rt = await createNativeRuntime({ ops: def });
    await rt.session("ops", "s1").turn({ turnId: "t1", userText: "hi" });
    expect(seenSystem).toBe("You are the ops assistant."); // runtime injected it — not baked into the model
  });

  test("session reset (#129) archives THIS session's history — the sibling session is untouched", async () => {
    const db = await openLocalSqliteSync(":memory:");
    const rt = new NativeRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } }, db);
    await rt.session("ops", "alice").turn({ turnId: "t1", userText: "Order 3 widgets" });
    await rt.session("ops", "bob").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(await rt.session("ops", "alice").reset()).toEqual({ previousSession: "alice#g0", generation: 0 });
    expect(rt.session("ops", "alice").transcript()).toHaveLength(0);
    expect(rt.session("ops", "bob").transcript()).toHaveLength(1); // session-scoped: bob keeps his history
    // the audit rows carry only the reset session, under its archived generation
    const rows = db.query("SELECT session_id, generation FROM agent_messages_archive").all() as { session_id: string; generation: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.session_id === "ops:alice" && r.generation === 0)).toBe(true);
    // and the retired session starts over cleanly
    expect(await rt.session("ops", "alice").turn({ turnId: "t2", userText: "Order 3 widgets" })).toBe("Done — order placed.");
  });
});
