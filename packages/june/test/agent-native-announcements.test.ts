// Input-announcement delivery on the in-process runtimes (#260) beyond the basic path
// (agent-native-stream.test.ts): a failed hook is retried on a timer, a restart delivers
// what the previous process left, and an actor mid-delivery is not evicted.

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InputAnnouncement, Model, ModelDelta, Tool } from "@junejs/core/agent-runtime";
import { createNativeRuntime, type AgentDef } from "../src/agent-native";

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

const dirs: string[] = [];
afterEach(() => {
  jest.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "june-260-"));
  dirs.push(dir);
  return join(dir, "agents.db");
};

async function park(rt: Awaited<ReturnType<typeof createNativeRuntime>>, agent: string, id: string) {
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
      const rt = await createNativeRuntime({ ops: def((a) => { if (!up) throw new Error("index down"); got.push(a.kind); }) });
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
      const down = await createNativeRuntime({ ops: def(() => { throw new Error("index down"); }) }, path);
      await park(down, "ops", "s1");
      await waitFor(() => errors.mock.calls.some((c) => String(c[0]).includes("delivering an input announcement failed")));
    } finally {
      errors.mockRestore();
    }
    const got: InputAnnouncement[] = [];
    await createNativeRuntime({ ops: def((a) => { got.push(a); }) }, path);
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ kind: "parked", agent: "ops", session: "s1", turnId: "t1" });
  });

  test("the startup scan finds an agent whose name contains ':' and skips agents without a hook", async () => {
    const path = dbPath();
    const first = await createNativeRuntime({ "ops:v2": def(() => { throw new Error("down"); }), other: def(() => { throw new Error("down"); }) }, path);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await park(first, "ops:v2", "s1");
      await park(first, "other", "s1");
      await waitFor(() => errors.mock.calls.length >= 2);
    } finally {
      errors.mockRestore();
    }
    const got: string[] = [];
    const next = await createNativeRuntime({ "ops:v2": def((a) => { got.push(`${a.agent}/${a.session}`); }), other: def() }, path);
    await waitFor(() => got.length === 1);
    expect(got).toEqual(["ops:v2/s1"]);
    expect(next.sessionCount).toBe(1); // only the agent with a hook was built
  });

  test("an actor with a delivery in flight is not evicted, so nothing is handed over twice", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rt = await createNativeRuntime({ ops: def(async (a) => { seen.push(a.id); await gate; }) }, ":memory:", { maxSessions: 1 });
    await park(rt, "ops", "s1");
    await waitFor(() => seen.length === 1); // the hook holds the announcement, not yet removed
    rt.session("ops", "s2"); // would evict s1 if it counted as idle
    rt.session("ops", "s1"); // …and rebuilding it would deliver the same announcement again
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
  });
});
