// The native mountAgent's streaming seams (#169): ctx.runStream / ctx.resumeStream over
// the in-process session, and slackChannel({ stream: true }) actually streaming on the
// native host instead of silently degrading to one chat.postMessage.

import { afterEach, describe, expect, test } from "bun:test";

import { defineAgent } from "@junejs/core/agent-config";
import type { Model, ModelDelta, Tool, TurnEvent } from "@junejs/core/agent-runtime";
import { slackChannel } from "@junejs/core/channels";
import { signSlackRequest } from "@junejs/core/test";
import { createNativeRuntime, mountAgent } from "../src/agent-native";

// Answers with two text deltas; with `approve`, first calls a tool that parks on requestInput.
function model(opts: { approve?: boolean } = {}): Model {
  return (msgs) =>
    (async function* (): AsyncGenerator<ModelDelta> {
      const hasTool = msgs.some((m) => m.role === "tool");
      if (opts.approve && !hasTool) {
        yield { type: "done", reply: { text: "", toolCalls: [{ id: "c1", name: "approve", input: {} }] } };
        return;
      }
      yield { type: "text", text: "Hel" };
      yield { type: "text", text: "lo" };
      yield { type: "done", reply: { text: "Hello", toolCalls: [] } };
    })();
}
const approveTool: Tool = {
  spec: { name: "approve", description: "", input: { type: "object" } },
  run: async (_input, ctx) => ({ approved: await ctx.requestInput({ id: "a1", prompt: "Approve?" }) }),
};

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// Poll a condition with a bounded deadline (never a fixed sleep: a loaded CI worker may
// legitimately take longer, and a condition that never holds must fail, not hang).
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("native mountAgent streaming (#169)", () => {
  test("ctx.runStream yields the turn's live events and ends on turn.completed", async () => {
    const agent = defineAgent({ name: "ops", instructions: "" });
    const rt = await createNativeRuntime({ ops: { model: model(), tools: [] } });
    const { ctx } = mountAgent(agent, rt);

    const events = await collect(ctx.runStream!("hi", { session: "s1" }));
    expect(events.map((e) => e.type)).toEqual(["turn.started", "message.delta", "message.delta", "message.completed", "turn.completed"]);
    expect(rt.session("ops", "s1").transcript()[0]!.text).toBe("Hello");
  });

  test("ctx.resumeStream answers a parked turn and streams the continuation", async () => {
    const agent = defineAgent({ name: "ops", instructions: "" });
    const rt = await createNativeRuntime({ ops: { model: model({ approve: true }), tools: [approveTool] } });
    const { ctx } = mountAgent(agent, rt);

    const parked = await collect(ctx.runStream!("ship it", { session: "s1" }));
    const requested = parked.at(-1)!;
    expect(requested).toMatchObject({ type: "input.requested", request: { id: "a1" } });

    const resumed = await collect(ctx.resumeStream!({ session: "s1", turnId: requested.turnId, inputId: "a1", input: true }));
    expect(resumed.at(-1)).toMatchObject({ type: "turn.completed", text: "Hello" });
    expect(rt.session("ops", "s1").transcript()[0]!.steps).toEqual([{ name: "approve", done: true, result: { approved: true } }]);
  });

  test("a refused start surfaces on the first pull, not as a hung stream", async () => {
    const agent = defineAgent({ name: "ops", instructions: "" });
    const rt = await createNativeRuntime({ ops: { model: model({ approve: true }), tools: [approveTool] } });
    const { ctx } = mountAgent(agent, rt);
    await collect(ctx.runStream!("ship it", { session: "s1" })); // parks the session

    await expect(collect(ctx.runStream!("another", { session: "s1" }))).rejects.toThrow(/suspended awaiting input/);
  });

  test("a stream queued behind a turn that parks ends with turn.failed instead of hanging", async () => {
    const agent = defineAgent({ name: "ops", instructions: "" });
    const rt = await createNativeRuntime({ ops: { model: model({ approve: true }), tools: [approveTool] } });
    const { ctx } = mountAgent(agent, rt);

    // A starts and is still running when B is accepted and queued behind it; A then parks,
    // so B's run-time check refuses it on the chain — B's stream must still terminate.
    const a = ctx.runStream!("ship it", { session: "s1" })[Symbol.asyncIterator]();
    await a.next(); // A has started (turn.started)
    const b = collect(ctx.runStream!("another", { session: "s1" }));
    const hang = new Promise<"hang">((r) => setTimeout(() => r("hang"), 1000));
    const outcome = await Promise.race([b, hang]);

    expect(outcome).not.toBe("hang");
    const last = (outcome as TurnEvent[]).at(-1)!;
    expect(last).toMatchObject({ type: "turn.failed", error: { message: expect.stringContaining("suspended awaiting input") } });
    await collect({ [Symbol.asyncIterator]: () => a }); // drain A (it parked)
  });

  test("slackChannel({ stream: true }) streams through chat.startStream on the native host", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const method = String(url).split("/").pop()!;
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : {} });
      return Response.json(method === "chat.startStream" ? { ok: true, ts: "111.9" } : { ok: true });
    }) as typeof fetch;
    const errors: unknown[] = [];
    const slack = slackChannel({ signingSecret: "s3cret", botToken: "xoxb", apiUrl: "https://slack.test", stream: true, onError: (e) => errors.push(e) });
    const agent = defineAgent({ name: "ops", instructions: "", channels: [slack] });
    const rt = await createNativeRuntime({ ops: { model: model(), tools: [] } });
    const mounted = mountAgent(agent, rt);

    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "app_mention", text: "<@UBOT> hi", channel: "C1", ts: "1.1", user: "U1" } });
    const res = await mounted.fetch(await signSlackRequest("s3cret", body, { url: "http://test/channels/slack" }));
    expect(res?.status).toBe(200);
    // the turn + render run in the background after the ACK: wait for the terminal call
    await waitFor(() => calls.some((c) => c.method === "chat.stopStream" || c.method === "chat.postMessage") || errors.length > 0);

    expect(errors).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["chat.startStream", "chat.appendStream", "chat.stopStream"]);
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });
});
