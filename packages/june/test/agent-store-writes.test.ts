// What the agents-durable-turns doc promises about writes inside a tool, run for
// real on both SQL backends:
//   • the documented exactly-once example (extracted from the page itself, so the
//     doc can't drift from what runs) writes through ctx.store on native SQLite
//     AND on a Durable Object's ctx.storage.sql, and refuses on the memory backend
//   • a non-async tool that returns a Promise commits `{}` — the corruption mode
//     the page documents as the reason to declare such tools `async`

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { replyStream, type Model, type ModelReply, type Msg, type Tool } from "@junejs/core/agent-runtime";
import { AgentDurableObject, sseTurnFinalText, type DurableStorage, type SqlStorage } from "../src/agent-durable";
import { createAgentRuntime, createNativeRuntime } from "../src/agent-native";
import { openLocalSqliteSync } from "../src/sqlite-driver";

const DOC = fileURLToPath(new URL("../../../apps/june.build/content/docs/agents-durable-turns.md", import.meta.url));

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "june-store-writes-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The page's one ```ts block that defines storeWrite(), as a runnable module.
// Its only import is `import type`, which the transpiler erases, so it runs from a
// temp dir with no package resolution.
async function documentedCreateOrder(): Promise<Tool> {
  const blocks = [...readFileSync(DOC, "utf8").matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const snippet = blocks.find((b) => b.includes("function storeWrite("));
  if (!snippet) throw new Error("agents-durable-turns.md no longer has the storeWrite example");
  const file = join(tempDir(), "create_order.ts");
  writeFileSync(file, snippet);
  return ((await import(file)) as { default: Tool }).default;
}

// Call create_order once, then answer.
const ORDER: Model = (msgs: Msg[]) =>
  msgs.some((m) => m.role === "tool")
    ? replyStream({ text: "ordered", toolCalls: [] })
    : replyStream({ text: "", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget" } }] });

async function fakeStorage(): Promise<DurableStorage & { rows(sql: string): unknown[] }> {
  const db = await openLocalSqliteSync(":memory:");
  cleanup.push(() => db.close());
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
    rows: (q) => db.query(q).all(),
  };
}

describe("the documented exactly-once write (agents-durable-turns.md)", () => {
  test("native SQLite: the order row commits through ctx.store's query(sql).run()", async () => {
    const createOrder = await documentedCreateOrder();
    const path = join(tempDir(), "agent.sqlite");
    const rt = await createNativeRuntime({ ops: { model: ORDER, tools: [createOrder] } }, path);
    expect(await rt.session("ops", "s1").turn({ userText: "order a widget" })).toBe("ordered");

    const db = await openLocalSqliteSync(path);
    cleanup.push(() => db.close());
    expect(db.query("select item from orders").all()).toEqual([{ item: "widget" }]);
  });

  test("Durable Object: the order row commits through ctx.storage.sql's exec()", async () => {
    const createOrder = await documentedCreateOrder();
    const storage = await fakeStorage();
    const agent = new AgentDurableObject({ storage }, { name: "ops", model: ORDER, tools: [createOrder] });
    const res = await agent.fetch(new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: "order a widget", turnId: "t1" }) }));
    expect(await sseTurnFinalText(res)).toBe("ordered");
    expect(storage.rows("select item from orders")).toEqual([{ item: "widget" }]);
  });

  test("memory backend: no store handle, so the write refuses instead of vanishing", async () => {
    const createOrder = await documentedCreateOrder();
    const rt = await createAgentRuntime({ ops: { model: ORDER, tools: [createOrder] } }, { backend: "memory" });
    const s = rt.session("ops", "s1");
    const { turnId } = s.start({ userText: "order a widget" });
    expect(await s.result(turnId)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("no transactional store handle") },
    });
  });
});

describe("a non-async tool that returns a Promise (the documented hazard)", () => {
  test("commits `{}`: the step, the transcript, and the model all see an empty result", async () => {
    let finished = false;
    const notAsync: Tool = {
      spec: { name: "create_order", description: "returns a Promise without being async", input: { type: "object" } },
      // a plain function → classified local; its Promise is committed unresolved
      run: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve({ orderId: 42 });
          }, 5),
        ),
    };
    const modelSaw: unknown[] = [];
    const model: Model = (msgs: Msg[]) => {
      const tool = msgs.find((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool");
      if (!tool) return replyStream({ text: "", toolCalls: [{ id: "c1", name: "create_order", input: {} }] });
      modelSaw.push(tool.result);
      return replyStream({ text: "done", toolCalls: [] } satisfies ModelReply);
    };
    const path = join(tempDir(), "agent.sqlite");
    const rt = await createNativeRuntime({ ops: { model, tools: [notAsync] } }, path);
    await rt.session("ops", "s1").turn({ userText: "go" });

    const db = await openLocalSqliteSync(path);
    cleanup.push(() => db.close());
    const step = db.query("select output from agent_steps where id like 'tool:%'").get() as { output: string };
    expect(JSON.parse(step.output)).toEqual({}); // the Promise, serialized
    const toolMsg = (db.query("select body from agent_messages").all() as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body) as Msg)
      .find((m) => m.role === "tool") as Extract<Msg, { role: "tool" }>;
    expect(toolMsg.result).toEqual({});
    expect(JSON.parse(JSON.stringify(modelSaw))).toEqual([{}]); // what the model is actually sent

    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(true); // …while the real work still ran, outside the transaction
  });
});
