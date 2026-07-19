// The @junejs/core/test helpers (#93), proven against the REAL channels — the
// signing helpers must satisfy the same verification that runs in production,
// and the fake context must drive the same webhook paths apps exercise.

import { describe, expect, test } from "bun:test";
import { makeTestContext, signSlackRequest, signCrispRequest, turnEvents } from "@junejs/core/test";
import { slackChannel, crispChannel } from "@junejs/core/channels";
import type { TurnEvent } from "@junejs/core/agent-runtime";

const realFetch = globalThis.fetch;

describe("@junejs/core/test (#93)", () => {
  test("signSlackRequest passes the real channel's signature check end-to-end", async () => {
    const sent: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const ch = slackChannel({ signingSecret: "s3", botToken: "xoxb", apiUrl: "https://slack.test" });
      const ctx = makeTestContext({ reply: (m) => `re: ${m}` });
      const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "1.1" } });
      const res = await ch.webhook!(await signSlackRequest("s3", body), ctx);
      expect(res.status).toBe(200);
      await ctx.flush(); // exact join on the fast-ACK background work — no sleep guessing
      expect(ctx.calls.run).toEqual([{ message: "hi", opts: expect.objectContaining({ session: "slack:C1:1.1" }) }]);
      expect(sent[0]!.body).toMatchObject({ channel: "C1", text: "re: hi" });
      // and a WRONG secret is rejected by the same production path
      expect((await ch.webhook!(await signSlackRequest("wrong", body), makeTestContext())).status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("signCrispRequest passes the real crisp verification; stale ts override is rejected", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const ch = crispChannel({ signingSecret: "ck", identifier: "id", key: "k", apiUrl: "https://crisp.test" });
      const ctx = makeTestContext();
      const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "yo", website_id: "w1", session_id: "s1" } });
      expect((await ch.webhook!(await signCrispRequest("ck", body), ctx)).status).toBe(200);
      await ctx.flush();
      expect(ctx.calls.run[0]).toMatchObject({ message: "yo" });
      // ts override → the replay guard (±5 min) rejects a stale-but-correctly-signed request
      const stale = await signCrispRequest("ck", body, { ts: String(Date.now() - 10 * 60 * 1000) });
      expect((await ch.webhook!(stale, makeTestContext())).status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("turnEvents builds the streaming contract: deltas then exactly one terminal", () => {
    const ok = turnEvents({ turnId: "t1", reasoning: ["hmm"], deltas: ["Hel", "lo"] });
    expect(ok.map((e) => e.type)).toEqual(["turn.started", "reasoning.delta", "message.delta", "message.delta", "message.completed", "turn.completed"]);
    expect((ok.at(-1) as Extract<TurnEvent, { type: "turn.completed" }>).text).toBe("Hello"); // joined deltas
    const failed = turnEvents({ fail: "boom" });
    expect(failed.at(-1)).toMatchObject({ type: "turn.failed", error: { message: "boom" } });
    const parked = turnEvents({ input: { id: "approve", prompt: "ok?" } });
    expect(parked.at(-1)).toMatchObject({ type: "input.requested", request: { id: "approve" } });
    // a caller-supplied trigger is used verbatim — note and future fields survive
    const seeded = turnEvents({ trigger: { kind: "proactive", by: "cron:daily", note: "9am sweep" } });
    expect(seeded[0]).toMatchObject({ type: "turn.started", trigger: { by: "cron:daily", note: "9am sweep" } });
    // the full TurnTrigger union is representable — an inbound stream opens like the real engine's
    const inbound = turnEvents({ trigger: { kind: "inbound", event: { source: "slack", kind: "message", channelId: "C1", ts: "1.1", raw: {} } } });
    expect(inbound[0]).toMatchObject({ type: "turn.started", trigger: { kind: "inbound", event: { channelId: "C1" } } });
    // contradictory terminals throw instead of silently picking a winner
    expect(() => turnEvents({ text: "ok", fail: "boom" })).toThrow(/at most ONE terminal/);
    expect(() => turnEvents({ fail: "boom", input: { id: "i", prompt: "?" } })).toThrow(/at most ONE terminal/);
    // engine fidelity: a blank-text turn completes WITHOUT message.completed (tool-only turns)
    expect(turnEvents({}).map((e) => e.type)).toEqual(["turn.started", "turn.completed"]);
    expect(turnEvents({ text: "  " }).map((e) => e.type)).toEqual(["turn.started", "turn.completed"]);
  });

  test("streamEvents enables runStream and drives the real streamed render path", async () => {
    const sent: { url: string; body?: { markdown_text?: string } }[] = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return Response.json({ ok: true, ts: "77.7" });
    }) as typeof fetch;
    try {
      const ch = slackChannel({ signingSecret: "s3", botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
      const ctx = makeTestContext({ streamEvents: turnEvents({ deltas: ["par", "tial"] }) });
      const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "go", channel: "C1", ts: "2.2" } });
      await ch.webhook!(await signSlackRequest("s3", body), ctx);
      await ctx.flush();
      expect(ctx.calls.runStream).toHaveLength(1); // feature-detected BECAUSE the fixture enabled it
      expect(ctx.calls.run).toHaveLength(0);
      expect(sent.some((c) => c.url.includes("chat.startStream") || c.url.includes("chat.appendStream"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("detached + resumeEvents enable their surfaces; flush settles work enqueued while settling", async () => {
    const ctx = makeTestContext({ detached: { turnId: "t_D" }, resumeEvents: turnEvents({ text: "resumed" }) });
    expect(await ctx.runDetached!("assess", { session: "s" })).toEqual({ turnId: "t_D" });
    expect(ctx.calls.runDetached[0]).toMatchObject({ message: "assess" });
    const got: TurnEvent[] = [];
    for await (const e of ctx.resumeStream!({ turnId: "t1", inputId: "i", input: true })) got.push(e);
    expect(got.at(-1)).toMatchObject({ type: "turn.completed", text: "resumed" });
    // a background task that enqueues ANOTHER background task still settles in one flush
    let done = false;
    ctx.waitUntil(Promise.resolve().then(() => { ctx.waitUntil(Promise.resolve().then(() => { done = true; })); }));
    await ctx.flush();
    expect(done).toBe(true);
    // a REJECTED background task surfaces from flush (after all waves settle) — a broken
    // custom channel must not produce a green test; later waves still ran to completion
    let lateRan = false;
    ctx.waitUntil(Promise.reject(new Error("post-ACK work broke")));
    ctx.waitUntil(Promise.resolve().then(() => { lateRan = true; }));
    // let macrotasks pass BEFORE flushing: the rejection must not trip the runtime's
    // unhandled-rejection reporter in the window between capture and flush()
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await expect(ctx.flush()).rejects.toThrow(/1 background task/);
    expect(lateRan).toBe(true);
    // a context WITHOUT the opt-ins exposes none of the optional surfaces (feature-detection stays honest)
    const bare = makeTestContext();
    expect(bare.runStream).toBeUndefined();
    expect(bare.runDetached).toBeUndefined();
    expect(bare.resumeStream).toBeUndefined();
  });
});
