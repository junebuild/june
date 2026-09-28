// Pending-input announcements on the in-process runtimes (#260): the runtime hands each
// session's outbox to the agent's onPendingInput after every park and resolution, on every
// (re)build, and — native only — for every session with undelivered rows at startup.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model, ModelDelta, PendingInputChange, PendingInputHook, Tool, TurnEvent } from "@junejs/core/agent-runtime";
import { createNativeRuntime, MemoryRuntime, type AgentDef } from "../src/agent-native";

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
const def = (onPendingInput?: PendingInputHook): AgentDef => ({ model, tools: [approve], ...(onPendingInput ? { onPendingInput } : {}) });

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const label = (c: PendingInputChange) => (c.kind === "resolved" ? `${c.session}:resolved:${c.outcome}` : `${c.session}:requested`);

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "june-260-"));
  dirs.push(dir);
  return join(dir, "agents.db");
};

describe("pending-input announcements on the in-process runtimes (#260)", () => {
  for (const backend of ["native", "memory"] as const) {
    test(`${backend}: a park, its answer and a reset are delivered in order`, async () => {
      const got: string[] = [];
      const agents = { ops: def((c) => { got.push(label(c)); }) };
      const rt = backend === "native" ? await createNativeRuntime(agents) : new MemoryRuntime(agents);

      const s1 = rt.session("ops", "s1");
      s1.start({ turnId: "t1", userText: "ship it" });
      await s1.result("t1");
      await waitFor(() => got.length === 1);
      s1.resume("t1", "a1", true);
      await s1.result("t1");
      await waitFor(() => got.length === 2);

      const s2 = rt.session("ops", "s2");
      s2.start({ turnId: "t2", userText: "ship it" });
      await s2.result("t2");
      await s2.reset();
      await waitFor(() => got.length === 4);
      expect(got).toEqual(["s1:requested", "s1:resolved:answered", "s2:requested", "s2:resolved:cancelled"]);
    });
  }

  test("native: a restart delivers what the previous process committed but never delivered", async () => {
    const path = dbPath();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      // First process: the index is down, so the announcement stays in the outbox.
      const down = await createNativeRuntime({ ops: def(() => { throw new Error("index unavailable"); }) }, path);
      const s = down.session("ops", "s1");
      s.start({ turnId: "t1", userText: "ship it" });
      await s.result("t1");
      await waitFor(() => errors.mock.calls.some((c) => String(c[0]).includes("onPendingInput failed")));
    } finally {
      errors.mockRestore();
    }

    // Second process over the same file: startup recovery delivers it, without any request.
    const got: PendingInputChange[] = [];
    await createNativeRuntime({ ops: def((c) => { got.push(c); }) }, path);
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ kind: "requested", agent: "ops", session: "s1", turnId: "t1", inputId: "a1", prompt: "Approve?" });
  });

  test("native: startup recovery finds an agent whose name contains ':'", async () => {
    const path = dbPath();
    const first = await createNativeRuntime({ "ops:v2": def() }, path);
    const s = first.session("ops:v2", "s1");
    s.start({ turnId: "t1", userText: "ship it" });
    await s.result("t1");
    const got: PendingInputChange[] = [];
    await createNativeRuntime({ "ops:v2": def((c) => { got.push(c); }) }, path);
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ agent: "ops:v2", session: "s1", id: "ops%3Av2/s1/t1/a1/requested" });
  });

  test("native: startup recovery skips sessions of agents without a hook", async () => {
    const path = dbPath();
    const first = await createNativeRuntime({ ops: def(), other: def() }, path);
    for (const agent of ["ops", "other"]) {
      const s = first.session(agent, "s1");
      s.start({ turnId: "t1", userText: "ship it" });
      await s.result("t1");
    }
    const got: string[] = [];
    const next = await createNativeRuntime({ ops: def((c) => { got.push(c.id); }), other: def() }, path);
    await waitFor(() => got.length === 1);
    expect(got).toEqual(["ops/s1/t1/a1/requested"]);
    expect(next.sessionCount).toBe(1); // only the session with a hook was built
  });

  test("native: the delivery listener does not keep an idle session from being evicted", async () => {
    const rt = await createNativeRuntime({ ops: def(() => {}) }, ":memory:", { maxSessions: 1 });
    const s1 = rt.session("ops", "s1");
    s1.start({ turnId: "t1", userText: "ship it" });
    await s1.result("t1");
    rt.session("ops", "s2");
    expect(rt.sessionCount).toBe(1);
  });

  test("native: a session is not evicted while its delivery is in flight, so no row is handed over twice", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rt = await createNativeRuntime({ ops: def(async (c) => { seen.push(c.id); await gate; }) }, ":memory:", { maxSessions: 1 });
    const s1 = rt.session("ops", "s1");
    s1.start({ turnId: "t1", userText: "ship it" });
    await s1.result("t1");
    await waitFor(() => seen.length === 1); // the hook holds the row, not yet deleted
    rt.session("ops", "s2"); // would evict s1 if it counted as idle
    rt.session("ops", "s1"); // …and this would rebuild it and deliver the same row again
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["ops/s1/t1/a1/requested"]);
  });

  test("native: input.resolved reaches a live subscriber of the session", async () => {
    const rt = await createNativeRuntime({ ops: def(() => {}) });
    const s = rt.session("ops", "s1");
    const events: TurnEvent[] = [];
    s.observe((e) => events.push(e));
    s.start({ turnId: "t1", userText: "ship it" });
    await s.result("t1");
    s.resume("t1", "a1", true, { by: "U1" });
    await s.result("t1");
    expect(events.find((e) => e.type === "input.resolved")).toEqual({ type: "input.resolved", turnId: "t1", inputId: "a1", outcome: "answered", by: "U1" });
  });
});
