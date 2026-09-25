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
      rt1.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets", crash: { at: "after-tool-commit", step: "tool:1:c1" } }),
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

  test("session reads use an index on agent_messages(session_id), added to an existing file too (#168)", async () => {
    const path = tmpDbPath();
    // a file written before the index existed
    const legacy = await openLocalSqliteSync(path);
    legacy.exec(`CREATE TABLE agent_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, body TEXT)`);
    legacy.close();

    const rt = await createNativeRuntime({ ops: { model: scriptedModel(ORDER_SCRIPT), tools: [createOrderTool()] } }, path);
    expect(await rt.session("ops", "s1").turn({ turnId: "t1", userText: "Order 3 widgets" })).toBe("Done — order placed.");

    const db = await openLocalSqliteSync(path);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT body FROM agent_messages WHERE session_id = ? ORDER BY seq").all("ops:s1") as { detail: string }[];
    db.close();
    expect(plan.map((r) => r.detail).join("\n")).toContain("USING INDEX agent_messages_session");
  });

  test("hasOpeningMessage matches this session's opening user/trigger message for the turn only (#168)", async () => {
    const seen: Record<string, boolean> = {};
    const probe: Tool = {
      spec: { name: "probe", description: "", input: { type: "object" } },
      run: (_input, ctx) => {
        for (const t of ["t1", "t2"]) seen[`${ctx.sessionId}:${t}`] = ctx.store.hasOpeningMessage(t);
        return {};
      },
    };
    const model = scriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "probe", input: {} }] },
      { text: "ok", toolCalls: [] },
    ]);
    const rt = await createNativeRuntime({ ops: { model, tools: [probe] } });
    await rt.session("ops", "a").turn({ turnId: "t1", userText: "hi" });
    // proactive: b's t2 opens with a `trigger` row, not a `user` one — both roles must match
    await rt.session("ops", "b").turn({ turnId: "t2", userText: "hi", trigger: { kind: "proactive", by: "cron:daily" } });
    const bOpening = rt.session("ops", "b").transcript()[0]!;
    expect(bOpening.by).toBe("cron:daily"); // really persisted as a trigger message

    // a's t1 opened (user); b's t2 opened (trigger); neither turn exists in the other
    // session (and the assistant/tool rows of a turn don't count as its opening)
    expect(seen).toEqual({ "a:t1": true, "a:t2": false, "b:t1": false, "b:t2": true });
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

describe("NativeRuntime session eviction (#174)", () => {
  const answer: Model = () => replyStream({ text: "ok", toolCalls: [] });

  test("past maxSessions, least recently used idle actors are dropped and rebuilt from SQLite on next use", async () => {
    const rt = await createNativeRuntime({ ops: { model: answer, tools: [] } }, ":memory:", { maxSessions: 2 });
    const a = rt.session("ops", "a");
    await a.turn({ turnId: "t1", userText: "hi" });
    await rt.session("ops", "b").turn({ turnId: "t1", userText: "hi" });
    rt.session("ops", "a"); // touch: b is now the least recently used
    await rt.session("ops", "c").turn({ turnId: "t1", userText: "hi" });

    expect(rt.sessionCount).toBe(2);
    expect(rt.session("ops", "a")).toBe(a); // kept (recently used)
    const b = rt.session("ops", "b"); // evicted → rebuilt: a new actor over the same rows
    expect(b.transcript().map((t) => t.text)).toEqual(["ok"]);
    await b.turn({ turnId: "t2", userText: "again" });
    expect(b.transcript()).toHaveLength(2);
  });

  test("a session with a turn in flight or a live subscriber is never evicted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Model = (msgs) => (async function* () {
      if (msgs.some((m) => m.role === "user" && m.text === "slow")) await gate;
      yield { type: "done", reply: { text: "ok", toolCalls: [] } } as const;
    })();
    const rt = await createNativeRuntime({ ops: { model: slow, tools: [] } }, ":memory:", { maxSessions: 1 });

    const busy = rt.session("ops", "busy");
    const { turnId } = busy.start({ userText: "slow" });
    const watched = rt.session("ops", "watched");
    const unwatch = watched.observe(() => {});
    rt.session("ops", "third");

    expect(rt.sessionCount).toBe(3); // over the soft cap: nothing was safe to drop
    expect(rt.session("ops", "busy")).toBe(busy);
    expect(rt.session("ops", "watched")).toBe(watched);

    release();
    await busy.result(turnId);
    unwatch();
    rt.session("ops", "fourth"); // now all three older ones are idle and unobserved
    expect(rt.sessionCount).toBe(1);
  });
});
