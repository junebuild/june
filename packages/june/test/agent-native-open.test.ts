// createNativeRuntime({ open }) (#399): a host that opens the sessions file itself — keyed
// per tenant (SQLCipher or similar), or on another driver — still gets everything the
// built-in open gives it: the durable journal, the startup announcement recovery (#260),
// and close() closing the handle (#317), including when the runtime fails to start. Real
// SQLCipher is not a dependency; a file that is not a database fails the same way a wrong
// key does (SQLITE_NOTADB on the first read).

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InputAnnouncement, Model, ModelDelta, Tool } from "@junejs/core/agent-runtime";
import { createAgentRuntime, createNativeRuntime, type AgentDef } from "../src/agent-native";
import { fromPrepare, type SyncSqlite } from "../src/sqlite-driver";

// Parks on the first call (a tool that asks for input), answers on the continuation.
const model: Model = (msgs) =>
  (async function* (): AsyncGenerator<ModelDelta> {
    if (!msgs.some((m) => m.role === "tool")) {
      yield { type: "done", reply: { text: "", toolCalls: [{ id: "c1", name: "approve", input: {} }] } };
      return;
    }
    yield { type: "done", reply: { text: "Done", toolCalls: [] } };
  })();
const approve: Tool = {
  spec: { name: "approve", description: "", input: { type: "object" } },
  run: async (_input, ctx) => ({ approved: await ctx.requestInput({ id: "a1", prompt: "Approve?" }) }),
};
const def = (onInputAnnouncement?: AgentDef["onInputAnnouncement"]): AgentDef => ({ model, tools: [approve], ...(onInputAnnouncement ? { onInputAnnouncement } : {}) });

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A handle the test opened, counting the closes the runtime makes on it.
function tracked(path: string): { db: SyncSqlite; closes: number } {
  const raw = new Database(path, { create: true });
  const t = {
    closes: 0,
    db: {
      query: (sql: string) => raw.query(sql),
      exec: (sql: string) => { raw.exec(sql); },
      close: () => { t.closes++; raw.close(); },
    } as SyncSqlite,
  };
  return t;
}

const runtimes: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "june-399-"));
  dirs.push(dir);
  return join(dir, "tenant.db");
};

describe("createNativeRuntime({ open }) (#399)", () => {
  test("open() is called once with the path, and the runtime stores its sessions in that handle", async () => {
    const path = dbPath();
    const seen: string[] = [];
    let handle: ReturnType<typeof tracked> | undefined;
    const rt = await createNativeRuntime({ ops: def() }, path, {
      open: async (p) => { seen.push(p); return (handle = tracked(p)).db; },
    });
    runtimes.push(rt);
    const s = rt.session("ops", "s1");
    s.start({ turnId: "t1", userText: "ship it" });
    await s.result("t1");

    expect(seen).toEqual([path]);
    const rows = handle!.db.query("SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?").get("ops:s1") as { n: number };
    expect(rows.n).toBeGreaterThan(0);
  });

  test("a synchronous open() is accepted too", async () => {
    const handle = tracked(":memory:");
    const rt = await createNativeRuntime({ ops: def() }, ":memory:", { open: () => handle.db });
    await rt.close();
    expect(handle.closes).toBe(1);
  });

  test("close() closes the handle open() returned, once, even when called twice", async () => {
    const handle = tracked(dbPath());
    const rt = await createNativeRuntime({ ops: def() }, ":memory:", { open: () => handle.db });
    await rt.close();
    await rt.close();
    expect(handle.closes).toBe(1);
  });

  test("a file handle from open() is switched to the durable journal (WAL, synchronous=FULL)", async () => {
    const path = dbPath();
    // Left in the default rollback journal on purpose: the runtime must set WAL itself.
    const handle = tracked(path);
    const rt = await createNativeRuntime({ ops: def() }, path, { open: () => handle.db });
    runtimes.push(rt);
    expect((handle.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((handle.db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2); // FULL
  });

  test("a restart through open() delivers what the previous process recorded (#260)", async () => {
    const path = dbPath();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const down = await createNativeRuntime({ ops: def(() => { throw new Error("index down"); }) }, path, { open: (p) => tracked(p).db });
      runtimes.push(down);
      const s = down.session("ops", "s1");
      s.start({ turnId: "t1", userText: "ship it" });
      await s.result("t1");
      await waitFor(() => errors.mock.calls.some((c) => String(c[0]).includes("delivering an input announcement failed")));
      await down.close();
    } finally {
      errors.mockRestore();
    }
    const got: InputAnnouncement[] = [];
    runtimes.push(await createNativeRuntime({ ops: def((a) => { got.push(a); }) }, path, { open: (p) => tracked(p).db }));
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ kind: "parked", agent: "ops", session: "s1", turnId: "t1" });
  });

  test("a runtime that fails to start closes the handle open() returned", async () => {
    const handle = tracked(":memory:");
    await expect(createNativeRuntime({ ops: def() }, ":memory:", { maxSessions: 0, open: () => handle.db })).rejects.toThrow(RangeError);
    expect(handle.closes).toBe(1);
  });

  test("a store open() cannot read (a wrong key) rejects, and its handle is closed once", async () => {
    const path = dbPath();
    writeFileSync(path, Buffer.alloc(4096, 0x5a)); // not a database: what a wrong key looks like
    const handle = tracked(path);
    await expect(createNativeRuntime({ ops: def() }, path, { open: () => handle.db })).rejects.toThrow(/not a database/);
    expect(handle.closes).toBe(1);
  });

  test("an open() that rejects rejects createNativeRuntime with its error", async () => {
    const boom = new Error("tenant key unavailable");
    await expect(createNativeRuntime({ ops: def() }, ":memory:", { open: async () => { throw boom; } })).rejects.toBe(boom);
  });

  test("an open() that returns something other than a SyncSqlite fails naming fromPrepare", async () => {
    const prepared = new Database(":memory:");
    const notASyncSqlite = { prepare: prepared.prepare.bind(prepared), exec: prepared.exec.bind(prepared), close: prepared.close.bind(prepared) };
    try {
      await expect(
        createNativeRuntime({ ops: def() }, ":memory:", { open: () => notASyncSqlite as unknown as SyncSqlite }),
      ).rejects.toThrow(/fromPrepare/);
      await expect(createNativeRuntime({ ops: def() }, ":memory:", { open: () => undefined as unknown as SyncSqlite })).rejects.toThrow(TypeError);
    } finally {
      prepared.close();
    }
  });

  test("createAgentRuntime hands open() to the native backend, and the memory backend never calls it", async () => {
    const path = dbPath();
    const handle = tracked(path);
    const native = await createAgentRuntime({ ops: def() }, { path, open: () => handle.db });
    await native.close();
    expect(handle.closes).toBe(1);

    let called = false;
    const memory = await createAgentRuntime({ ops: def() }, { backend: "memory", open: () => { called = true; return tracked(":memory:").db; } });
    await memory.close();
    expect(called).toBe(false);
  });

  test("a prepare()-shaped driver wrapped with fromPrepare runs a turn end to end", async () => {
    const path = dbPath();
    const rt = await createNativeRuntime({ ops: def() }, path, { open: (p) => fromPrepare(new Database(p, { create: true })) });
    runtimes.push(rt);
    const s = rt.session("ops", "s1");
    s.start({ turnId: "t1", userText: "ship it" });
    await s.result("t1");
    expect(s.snapshot().status).toBe("suspended"); // parked on requestInput, persisted through the adapter
  });
});
