// Input-announcement delivery on the in-process runtimes (#260) beyond the basic path
// (agent-native-stream.test.ts): a failed hook is retried on a timer, a restart delivers
// what the previous process left, and an actor mid-delivery is not evicted.

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { InputAnnouncement, Model, ModelDelta, Runtime, Tool } from "@junejs/core/agent-runtime";
import { createAgentRuntime, createNativeRuntime, MemoryRuntime, NativeRuntime, type AgentDef } from "../src/agent-native";
import { openLocalSqliteSync } from "../src/sqlite-driver";
import { createApp } from "../src/app";
import { startDevServer } from "../src/dev";

// Fixtures written at test time live UNDER the package so their JSX resolves June's runtime.
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

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
// Settle promise chains without a timer (usable while fake timers are installed).
async function microtasks(n = 50) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Every runtime a test builds is closed before its db dir is removed (#317): a runtime left
// open keeps its failed-delivery retry timer, which fires seconds later — in some other
// test file — against the deleted database.
const runtimes: Array<{ close(): Promise<void> }> = [];
const open = async (...args: Parameters<typeof createNativeRuntime>) => {
  const rt = await createNativeRuntime(...args);
  runtimes.push(rt);
  return rt;
};
const dirs: string[] = [];
afterEach(async () => {
  jest.useRealTimers();
  while (runtimes.length) await runtimes.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "june-260-"));
  dirs.push(dir);
  return join(dir, "agents.db");
};

async function park(rt: Runtime, agent: string, id: string) {
  const s = rt.session(agent, id);
  s.start({ turnId: "t1", userText: "ship it" });
  await s.result("t1");
}

describe("input announcements on the native runtime (#260)", () => {
  test("a failed hook is retried on a timer, with no further activity on the session", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      let up = false;
      const got: string[] = [];
      const rt = await open({ ops: def((a) => { if (!up) throw new Error("index down"); got.push(a.kind); }) });
      jest.useFakeTimers();
      await park(rt, "ops", "s1");
      await microtasks();
      expect(got).toEqual([]); // failed and kept

      up = true;
      jest.advanceTimersByTime(4_999);
      await microtasks();
      expect(got).toEqual([]); // not before the first backoff step
      jest.advanceTimersByTime(1);
      await microtasks();
      expect(got).toEqual(["parked"]); // the retry delivered it
    } finally {
      errors.mockRestore();
    }
  });

  test("a restart delivers what the previous process recorded, without the session being used", async () => {
    const path = dbPath();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const down = await open({ ops: def(() => { throw new Error("index down"); }) }, path);
      await park(down, "ops", "s1");
      await waitFor(() => errors.mock.calls.some((c) => String(c[0]).includes("delivering an input announcement failed")));
    } finally {
      errors.mockRestore();
    }
    const got: InputAnnouncement[] = [];
    await open({ ops: def((a) => { got.push(a); }) }, path);
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ kind: "parked", agent: "ops", session: "s1", turnId: "t1" });
  });

  test("the startup scan finds an agent whose name contains ':' and skips agents without a hook", async () => {
    const path = dbPath();
    const first = await open({ "ops:v2": def(() => { throw new Error("down"); }), other: def(() => { throw new Error("down"); }) }, path);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await park(first, "ops:v2", "s1");
      await park(first, "other", "s1");
      await waitFor(() => errors.mock.calls.length >= 2);
    } finally {
      errors.mockRestore();
    }
    const got: string[] = [];
    const next = await open({ "ops:v2": def((a) => { got.push(`${a.agent}/${a.session}`); }), other: def() }, path);
    await waitFor(() => got.length === 1);
    expect(got).toEqual(["ops:v2/s1"]);
    expect(next.sessionCount).toBe(1); // only the agent with a hook was built
  });

  test("an actor with a delivery in flight is not evicted, so nothing is handed over twice", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rt = await open({ ops: def(async (a) => { seen.push(a.id); await gate; }) }, ":memory:", { maxSessions: 1 });
    await park(rt, "ops", "s1");
    await waitFor(() => seen.length === 1); // the hook holds the announcement, not yet removed
    rt.session("ops", "s2"); // would evict s1 if it counted as idle
    rt.session("ops", "s1"); // …and rebuilding it would deliver the same announcement again
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
  });
});

describe("closing a runtime (#317)", () => {
  test("close() cancels a pending retry on the native runtime", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const rt = await open({ ops: def(() => { calls++; throw new Error("index down"); }) });
      jest.useFakeTimers();
      await park(rt, "ops", "s1");
      await microtasks();
      expect(calls).toBe(1); // failed, a retry is pending
      await rt.close();
      jest.advanceTimersByTime(300_000);
      await microtasks();
      expect(calls).toBe(1); // the retry never ran
    } finally {
      errors.mockRestore();
    }
  });

  test("close() cancels a pending retry on the memory runtime", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const rt = new MemoryRuntime({ ops: def(() => { calls++; throw new Error("index down"); }) });
      jest.useFakeTimers();
      await park(rt, "ops", "s1");
      await microtasks();
      expect(calls).toBe(1);
      await rt.close();
      jest.advanceTimersByTime(300_000);
      await microtasks();
      expect(calls).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  // The flush is not awaited by whoever triggered it, and after the hook resolves it writes
  // the outbox back. Closing the owned db under it would recreate the very failure close()
  // exists to prevent, so close() waits for in-flight work first.
  test("close() waits for a delivery in flight before closing the owned db", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const seen: string[] = [];
      const rt = await createNativeRuntime({ ops: def(async (a) => { seen.push(a.kind); await gate; }) });
      await park(rt, "ops", "s1");
      await waitFor(() => seen.length === 1); // the hook holds the delivery open

      let closed = false;
      const closing = rt.close().then(() => { closed = true; });
      await new Promise((r) => setTimeout(r, 30));
      expect(closed).toBe(false); // still waiting on the delivery
      expect(() => rt.session("ops", "s2")).toThrow(/closed/); // no new work meanwhile

      release();
      await closing;
      expect(closed).toBe(true);
      expect(errors.mock.calls.map((c) => String(c[0]) + String(c[1] ?? ""))).toEqual([]); // the write-back found the db open
    } finally {
      errors.mockRestore();
    }
  });

  test("createAgentRuntime hands back a runtime that can be closed, on both backends", async () => {
    for (const backend of ["native", "memory"] as const) {
      const rt = await createAgentRuntime({ ops: def() }, { backend });
      await rt.close();
      expect(() => rt.session("ops", "s1")).toThrow(/closed/);
    }
  });

  test("a createNativeRuntime that fails to start closes the db it opened", async () => {
    const closeSpy = spyOn(Database.prototype, "close");
    try {
      await expect(createNativeRuntime({ ops: def() }, ":memory:", { maxSessions: 0 })).rejects.toThrow(RangeError);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  // The app owns the runtime it builds for an agent/ directory, so the app's close() and
  // the dev server's stop() must shut it down; nobody else can reach it.
  test("createApp's close() shuts down the agent runtime it built", async () => {
    const root = mkdtempSync(join(PKG_DIR, ".tmp-close-"));
    dirs.push(root);
    mkdirSync(join(root, "app", "agent"), { recursive: true });
    writeFileSync(join(root, "app", "page.tsx"), "export default function P() { return <main>home</main>; }\n");
    writeFileSync(join(root, "app", "agent", "instructions.md"), "You help.\n");
    const closeSpy = spyOn(NativeRuntime.prototype, "close");
    try {
      const idle = createApp({ appDir: join(root, "app") });
      await idle.close(); // nothing built yet: nothing to close, and close() builds nothing
      expect(closeSpy).not.toHaveBeenCalled();

      const app = createApp({ appDir: join(root, "app") });
      expect((await app.fetch(new Request("http://june.test/"))).status).toBe(200); // builds the runtime
      await app.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  test("the dev server's stop() shuts the app's agent runtime down", async () => {
    const root = mkdtempSync(join(PKG_DIR, ".tmp-close-"));
    dirs.push(root);
    mkdirSync(join(root, "app", "agent"), { recursive: true });
    writeFileSync(join(root, "app", "page.tsx"), "export default function P() { return <main>home</main>; }\n");
    writeFileSync(join(root, "app", "agent", "instructions.md"), "You help.\n");
    const closeSpy = spyOn(NativeRuntime.prototype, "close");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const server = await startDevServer({ appDir: join(root, "app"), port: 4531 });
      expect((await fetch(`${server.url}/`)).status).toBe(200); // builds the runtime
      await server.stop(true);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      log.mockRestore();
    }
  });

  test("close() closes the db createNativeRuntime opened, never one passed in", async () => {
    const owned = await createNativeRuntime({ ops: def() }, dbPath());
    await owned.close();
    await owned.close(); // twice is fine
    expect(() => owned.recoverAnnouncements()).toThrow(); // its handle is closed

    const db = await openLocalSqliteSync(dbPath());
    const borrowed = new NativeRuntime({ ops: def() }, db);
    await borrowed.close();
    expect(db.query("SELECT 1 AS one").get()).toEqual({ one: 1 }); // still the caller's, still open
    db.close();
  });
});
