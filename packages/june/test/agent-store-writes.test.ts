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

// The page's one ```ts block that defines storeWrite(), as a runnable module. It imports
// a value (FatalToolError) from @junejs/core, so it runs from a temp dir INSIDE this
// package, where module resolution finds the workspace's @junejs/core.
async function documentedCreateOrder(): Promise<Tool> {
  const blocks = [...readFileSync(DOC, "utf8").matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const snippet = blocks.find((b) => b.includes("function storeWrite("));
  if (!snippet) throw new Error("agents-durable-turns.md no longer has the storeWrite example");
  const dir = mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), ".doc-snippet-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "create_order.ts");
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

describe("a non-async tool that returns a Promise (#233)", () => {
  const promised = (flag: { finished: boolean }, mode?: Tool["mode"]): Tool => ({
    spec: { name: "create_order", description: "returns a Promise without being async", input: { type: "object" } },
    run: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          flag.finished = true;
          resolve({ orderId: 42 });
        }, 5),
      ),
    ...(mode ? { mode } : {}),
  });
  const modelSeeing = (seen: unknown[]): Model => (msgs: Msg[]) => {
    const tool = msgs.find((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool");
    if (!tool) return replyStream({ text: "", toolCalls: [{ id: "c1", name: "create_order", input: {} }] });
    seen.push(tool.result);
    return replyStream({ text: "done", toolCalls: [] } satisfies ModelReply);
  };
  const toolRows = (path: string) => {
    const db = openLocalSqliteSync(path);
    return db.then((d) => {
      cleanup.push(() => d.close());
      const steps = d.query("select output from agent_steps where id like 'tool:%'").all() as { output: string }[];
      const msgs = (d.query("select body from agent_messages").all() as Array<{ body: string }>).map((r) => JSON.parse(r.body) as Msg);
      return { steps: steps.map((r) => JSON.parse(r.output)), toolMsgs: msgs.filter((m) => m.role === "tool") };
    });
  };

  test("classified local, it fails the turn instead of committing the Promise as `{}`", async () => {
    const flag = { finished: false };
    const seen: unknown[] = [];
    const path = join(tempDir(), "agent.sqlite");
    const rt = await createNativeRuntime({ ops: { model: modelSeeing(seen), tools: [promised(flag)] } }, path);
    const s = rt.session("ops", "s1");
    const { turnId } = s.start({ userText: "go" });
    expect(await s.result(turnId)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining('returned a Promise but runs local (sync) — declare its run `async`, or set mode: "remote"') },
    });
    expect(await toolRows(path)).toEqual({ steps: [], toolMsgs: [] }); // nothing committed
    expect(seen).toEqual([]); // the model never read a fake result
  });

  test('with mode: "remote" the same run is awaited and its real result committed', async () => {
    const flag = { finished: false };
    const seen: unknown[] = [];
    const path = join(tempDir(), "agent.sqlite");
    const rt = await createNativeRuntime({ ops: { model: modelSeeing(seen), tools: [promised(flag, "remote")] } }, path);
    expect(await rt.session("ops", "s1").turn({ userText: "go" })).toBe("done");
    expect(flag.finished).toBe(true);
    const rows = await toolRows(path);
    expect(rows.steps).toEqual([{ orderId: 42 }]);
    expect(rows.toolMsgs).toMatchObject([{ result: { orderId: 42 } }]);
    expect(seen).toEqual([{ orderId: 42 }]);
  });
});
