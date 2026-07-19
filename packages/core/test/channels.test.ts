// Channel factories + the channelFetch router. The webhook channels verify a
// real HMAC signature (computed here the same way the platform would), fast-ACK,
// run the turn in the background, and post the reply back out — asserted via a
// captured global fetch. Loop guards (self-messages) must NOT trigger a reply.

import { afterEach, describe, expect, test } from "bun:test";
import { channelFetch, defineChannel, resolveChannel, type AgentDefinition, type Channel, type ChannelContext } from "@junejs/core/agent-config";
import type { InboundEvent, ToolContext, TurnEvent } from "@junejs/core/agent-runtime";
import { crispChannel, httpChannel, slackChannel, receive, verifySlackSignature, verifyCrispSignature, verifyCrispUrlKey, tryParseJson, timestampFresh, normalizeSlackEvent, normalizeCrispEvent, isCrispEvent, type CrispWebhookEnvelope } from "@junejs/core/channels";

const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ctxWith(run: ChannelContext["run"], channels: Channel[] = []): ChannelContext {
  const agent: AgentDefinition = { name: "ops", instructions: "", tools: [], skills: [], channels, connections: [] };
  return { agent, run };
}

// capture outbound fetch (the reply-out edge)
let calls: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
function captureFetch() {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });
const flush = () => new Promise((r) => setTimeout(r, 20)); // let the background turn + reply-out settle

describe("httpChannel + channelFetch", () => {
  test("POST /message runs a turn and returns its text", async () => {
    const ch = httpChannel();
    const handler = ch.fetch!(ctxWith(async (m) => `echo: ${m}`));
    const res = await handler(new Request("http://x/message", { method: "POST", body: JSON.stringify({ message: "hi" }) }));
    expect(await res.json()).toEqual({ text: "echo: hi" });
  });

  test("/mcp is delegated when provided", async () => {
    const ch = httpChannel({ mcp: async () => Response.json({ ok: true }) });
    const handler = ch.fetch!(ctxWith(async () => ""));
    expect(await (await handler(new Request("http://x/mcp", { method: "POST" }))).json()).toEqual({ ok: true });
  });

  test("channelFetch dispatches a webhook by path and falls through to http", async () => {
    const hook = defineChannel({ name: "hook", path: "/hook", webhook: async () => new Response("hooked") });
    const agentRun = ctxWith(async (m) => `echo: ${m}`, [hook, httpChannel()]);
    const fetchHandler = channelFetch(agentRun.agent, agentRun);

    expect(await (await fetchHandler(new Request("http://x/hook", { method: "POST" })))!.text()).toBe("hooked");
    const msg = await fetchHandler(new Request("http://x/message", { method: "POST", body: JSON.stringify({ message: "yo" }) }));
    expect(await msg!.json()).toEqual({ text: "echo: yo" });
    expect(await fetchHandler(new Request("http://x/nope"))).toBeNull(); // no channel → fall through
  });
});

describe("slackChannel", () => {
  const secret = "shhh";
  const ch = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });

  async function signed(body: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = "v0=" + (await hmacHex(secret, `v0:${ts}:${body}`));
    return new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
  }

  test("echoes the url_verification challenge", async () => {
    const res = await ch.webhook!(await signed(JSON.stringify({ type: "url_verification", challenge: "abc" })), ctxWith(async () => ""));
    expect(await res.json()).toEqual({ challenge: "abc" });
  });

  test("a signed user message runs a turn and posts the reply back", async () => {
    captureFetch();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "order 3 widgets", channel: "C1", ts: "111.1" } });
    const res = await ch.webhook!(await signed(body), ctxWith(async (m) => `did: ${m}`));
    expect(res.status).toBe(200); // fast ACK
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.test/chat.postMessage");
    expect(calls[0]!.body).toMatchObject({ channel: "C1", text: "did: order 3 widgets", thread_ts: "111.1" });
  });

  test("passes a normalized InboundEvent (who/where/thread) into the turn", async () => {
    let seen: InboundEvent | undefined;
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "222.2", user: "U9" } });
    const run = (async (_m: string, o?: { event?: InboundEvent }) => { seen = o?.event; return "ok"; }) as ChannelContext["run"];
    await ch.webhook!(await signed(body), ctxWith(run));
    await flush();
    expect(seen).toMatchObject({ kind: "message", channelId: "C1", threadId: "222.2", ts: "222.2", user: { id: "U9" }, text: "hi" });
  });

  test("rejects a bad signature with 401", async () => {
    const req = new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=deadbeef" }, body: "{}" });
    expect((await ch.webhook!(req, ctxWith(async () => ""))).status).toBe(401);
  });

  test("rejects a stale timestamp with 401 (replay guard)", async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const body = "{}";
    const sig = "v0=" + (await hmacHex(secret, `v0:${oldTs}:${body}`)); // a VALID signature…
    const req = new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": oldTs, "x-slack-signature": sig }, body });
    expect((await ch.webhook!(req, ctxWith(async () => ""))).status).toBe(401); // …still rejected: too old
  });

  test("a signed but malformed body ACKs 200 (no retry storm), runs nothing", async () => {
    captureFetch();
    const res = await ch.webhook!(await signed("not json {"), ctxWith(async () => "should not run"));
    expect(res.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(0);
  });

  // a fetch stub returning a stream ts for chat.startStream so renderStream can append/stop
  function streamStub() {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const start = String(url).endsWith("/chat.startStream");
      return new Response(JSON.stringify(start ? { ok: true, ts: "111.9" } : { ok: true }), { status: 200 });
    }) as typeof fetch;
  }
  const method = (c: { url: string }) => c.url.split("/").pop();

  test("stream render: startStream → appendStream each token delta → stopStream", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    const stream: TurnEvent[] = [
      { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "x" } },
      { type: "message.delta", turnId: "t1", text: "Hel" },
      { type: "message.delta", turnId: "t1", text: "lo" },
      { type: "message.completed", turnId: "t1", text: "Hello" },
      { type: "turn.completed", turnId: "t1", text: "Hello" },
    ];
    const ctx = ctxWith(async () => "run() should not be used when streaming");
    ctx.runStream = async function* () { for (const e of stream) yield e; };

    const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" } });
    await ch2.webhook!(await signed(body), ctx);
    await flush();

    expect(calls.map((c) => [method(c), (c.body as { markdown_text?: string }).markdown_text])).toEqual([
      ["chat.startStream", "Hel"],            // seeded with the first token
      ["chat.appendStream", "lo"],            // subsequent tokens append natively (not chat.update)
      ["chat.stopStream", undefined],         // finalize
    ]);
    expect((calls[1]!.body as { ts?: string }).ts).toBe("111.9"); // appends target the stream ts
  });

  test("stream render: a one-shot (no-delta) turn appends the final text once, then stops", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () {
      yield { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "x" } } as TurnEvent;
      yield { type: "turn.completed", turnId: "t1", text: "Answer." } as TurnEvent;
    };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    expect(calls.map((c) => [method(c), (c.body as { markdown_text?: string }).markdown_text])).toEqual([
      ["chat.startStream", "Answer."], // no deltas → the whole reply seeds the stream
      ["chat.stopStream", undefined],
    ]);
  });

  test("stream render: a tool-only / empty turn posts nothing (no empty streamed message)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () {
      yield { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "x" } } as TurnEvent;
      yield { type: "action.requested", turnId: "t1", call: { id: "c1", name: "add_reaction", input: {} } } as TurnEvent;
      yield { type: "action.completed", turnId: "t1", call: { id: "c1", name: "add_reaction", input: {} }, result: {} } as TurnEvent;
      yield { type: "turn.completed", turnId: "t1", text: "" } as TurnEvent; // acted via a tool, no text
    };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "react", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    expect(calls).toHaveLength(0); // startStream was never opened → no empty message
  });

  test("stream render: startStream unavailable → a failure still reports via chat.postMessage", async () => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ ok: false, error: "unknown_method" }), { status: 200 }); // startStream returns no ts
    }) as typeof fetch;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, onError: () => {} });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () { yield { type: "turn.failed", turnId: "t1", error: { message: "boom" } } as TurnEvent; };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "x", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    // tried startStream (no ts), then posted the failure note once
    expect(calls.map(method)).toEqual(["chat.startStream", "chat.postMessage"]);
    expect((calls[1]!.body as { text?: string }).text).toContain("the turn failed");
  });

  // streamStub with a programmable response per Slack method — for the failure paths
  function stubSlack(respond: (m: string) => { json?: unknown; headers?: Record<string, string> } | undefined) {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const m = String(url).split("/").pop()!;
      const r = respond(m) ?? { json: m === "chat.startStream" ? { ok: true, ts: "111.9" } : { ok: true } };
      return new Response(JSON.stringify(r.json ?? { ok: true }), { status: 200, headers: r.headers });
    }) as typeof fetch;
  }
  const delta = (text: string) => ({ type: "message.delta", turnId: "t1", text }) as TurnEvent;
  const completed = (text: string) => ({ type: "turn.completed", turnId: "t1", text }) as TurnEvent;
  async function driveStream(ch2: Channel, events: TurnEvent[]) {
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () { for (const e of events) yield e; };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
  }
  const mdOf = (c: { body: unknown }) => (c.body as { markdown_text?: string }).markdown_text;

  test("stream render: a burst of deltas coalesces into one append (Tier-4 friendly)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    await driveStream(ch2, [delta("Hel"), delta("lo "), delta("wor"), delta("ld."), completed("Hello world.")]);
    expect(calls.map((c) => [method(c), mdOf(c)])).toEqual([
      ["chat.startStream", "Hel"], // the first token still seeds IMMEDIATELY
      ["chat.appendStream", "lo world."], // the burst arrived inside one flush window → ONE append
      ["chat.stopStream", undefined],
    ]);
  });

  test("stream render: stopped_by_user ends rendering — no more appends, no stopStream, no salvage", async () => {
    stubSlack((m) => (m === "chat.appendStream" ? { json: { ok: false, error: "stopped_by_user" } } : undefined));
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    // the oversized delta forces a mid-turn flush, which Slack refuses: the human hit Stop
    await driveStream(ch2, [delta("a"), delta("x".repeat(12000)), delta("never rendered"), completed("…")]);
    expect(calls.map(method)).toEqual(["chat.startStream", "chat.appendStream"]); // ceased, silently (their choice)
  });

  test("stream render: a hard append failure surfaces via onError and posts the tail (no silent truncation)", async () => {
    stubSlack((m) => (m === "chat.appendStream" ? { json: { ok: false, error: "message_not_in_streaming_state" } } : undefined));
    const errs: unknown[] = [];
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, onError: (e) => errs.push(e) });
    await driveStream(ch2, [delta("a"), delta("tail"), completed("a tail")]);
    expect(calls.map(method)).toEqual(["chat.startStream", "chat.appendStream", "chat.postMessage"]);
    expect((calls[2]!.body as { text?: string }).text).toBe("tail"); // the unsent tail still lands
    expect(String(errs[0])).toContain("message_not_in_streaming_state"); // and the failure is LOUD
  });

  test("stream render: a ratelimited append retries once (honoring Retry-After) with the same slice", async () => {
    let appends = 0;
    stubSlack((m) => (m === "chat.appendStream" && appends++ === 0 ? { json: { ok: false, error: "ratelimited" }, headers: { "retry-after": "0" } } : undefined));
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    await driveStream(ch2, [delta("a"), delta("b"), completed("ab")]);
    expect(calls.map(method)).toEqual(["chat.startStream", "chat.appendStream", "chat.appendStream", "chat.stopStream"]);
    expect(mdOf(calls[2]!)).toBe("b"); // the retry re-sends the SAME slice — nothing dropped
  });

  test("stream render: content over Slack's 12k markdown cap is sliced across appends", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    await driveStream(ch2, [completed("x".repeat(25000))]); // one-shot reply far over the cap
    expect(calls.map((c) => [method(c), mdOf(c)?.length])).toEqual([
      ["chat.startStream", 12000],
      ["chat.appendStream", 12000],
      ["chat.appendStream", 1000],
      ["chat.stopStream", undefined],
    ]);
  });

  test("stream render: an inbound channel stream carries the asker + workspace as recipient (live-verified contract)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () { yield delta("Hi."); yield completed("Hi."); };
    // team_id lives on the EVENT ENVELOPE, not the inner event — startStream needs it as
    // recipient_team_id for any channel stream, even in-thread (missing_recipient_team_id)
    const body = JSON.stringify({ type: "event_callback", team_id: "T42", event: { type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" } });
    await ch2.webhook!(await signed(body), ctx);
    await flush();
    expect(calls[0]!.body).toMatchObject({ channel: "C1", thread_ts: "1.1", recipient_user_id: "U1", recipient_team_id: "T42" });
  });

  test("stream render: a DM stream omits recipient ids (DMs reject them with invalid_arguments)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () { yield delta("Hi."); yield completed("Hi."); };
    // same envelope shape as a channel event — but the D-prefixed im id must flip the rule
    const body = JSON.stringify({ type: "event_callback", team_id: "T42", event: { type: "message", text: "hi", channel: "D777", ts: "1.1", user: "U1" } });
    await ch2.webhook!(await signed(body), ctx);
    await flush();
    const start = calls[0]!.body as Record<string, unknown>;
    expect(start).toMatchObject({ channel: "D777", thread_ts: "1.1" });
    expect("recipient_user_id" in start).toBe(false);
    expect("recipient_team_id" in start).toBe(false);
  });

  test("proactive: a top-level channel stream carries recipient ids (startStream requires them without thread_ts)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    async function* stream() { yield delta("Heads up."); yield completed("Heads up."); }
    await ch2.deliver!({ channelId: "C-ops", recipientUserId: "U7", recipientTeamId: "T7" }, stream());
    expect(calls[0]!.body).toMatchObject({ channel: "C-ops", recipient_user_id: "U7", recipient_team_id: "T7" });
    expect((calls[0]!.body as { thread_ts?: string }).thread_ts).toBeUndefined();
  });

  test("feedback: stopStream carries the 👍/👎 buttons, values tying back to {rating, turnId, session}", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, feedback: true });
    await driveStream(ch2, [delta("Hi."), completed("Hi.")]);
    const stop = calls.find((c) => method(c) === "chat.stopStream")!.body as { blocks?: { type: string; elements: { type: string; action_id: string; positive_button: { value: string }; negative_button: { value: string } }[] }[] };
    expect(stop.blocks![0]!.type).toBe("context_actions");
    const fb = stop.blocks![0]!.elements[0]!;
    expect(fb.type).toBe("feedback_buttons");
    expect(fb.action_id).toBe("june_feedback");
    expect(JSON.parse(fb.positive_button.value)).toEqual({ rating: "positive", turnId: "t1", session: "slack:C1:1.1" });
    expect(JSON.parse(fb.negative_button.value)).toEqual({ rating: "negative", turnId: "t1", session: "slack:C1:1.1" });
  });

  test("feedback: a button click is normalized into onFeedback (who, rating, turn, message)", async () => {
    streamStub();
    let seen: unknown;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, feedback: true, onFeedback: (fb) => { seen = fb; } });
    const value = JSON.stringify({ rating: "negative", turnId: "t1", session: "slack:C1:1.1" });
    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9", thread_ts: "5.5" }, actions: [{ action_id: "june_feedback", value }] };
    const res = await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctxWith(async () => "unused"));
    expect(res.status).toBe(200);
    await flush();
    expect(seen).toEqual({
      rating: "negative", turnId: "t1", session: "slack:C1:1.1",
      user: { id: "U1" }, channelId: "C1", threadId: "5.5", messageTs: "9.9",
    });
  });

  test("feedback: an unexpected rating value is NOT forwarded (the contract is positive|negative)", async () => {
    streamStub();
    let seen: unknown;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, feedback: true, onFeedback: (fb) => { seen = fb; } });
    const value = JSON.stringify({ rating: "meh", turnId: "t1" }); // not one of ours
    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9" }, actions: [{ action_id: "june_feedback", value }] };
    await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctxWith(async () => "unused"));
    await flush();
    expect(seen).toBeUndefined();
  });

  test("tasks: tool calls render as a native task timeline, in order with the text", async () => {
    streamStub();
    const ch2 = slackChannel({
      signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true,
      tasks: (call) => (call.name === "hidden" ? undefined : `Running ${call.name}`),
    });
    await driveStream(ch2, [
      { type: "action.requested", turnId: "t1", call: { id: "c1", name: "search", input: {} } } as TurnEvent,
      { type: "action.requested", turnId: "t1", call: { id: "c2", name: "hidden", input: {} } } as TurnEvent, // mapper hides this one
      delta("Found it."),
      { type: "action.completed", turnId: "t1", call: { id: "c1", name: "search", input: {} }, result: {} } as TurnEvent,
      completed("Found it."),
    ]);
    const chunkOf = (c: { body: unknown }) => (c.body as { chunks?: { type: string; id?: string; status?: string; text?: string }[] }).chunks?.[0];
    // tasks put the WHOLE stream in chunks mode — text rides as markdown_text chunks, because
    // mixing raw markdown_text into a chunks-opened stream is streaming_mode_mismatch (live)
    expect(calls.map((c) => [method(c), chunkOf(c)?.status ?? chunkOf(c)?.text])).toEqual([
      ["chat.startStream", "in_progress"], // the first tool call OPENS the stream (a chunk can seed it)
      ["chat.appendStream", "Found it."], // buffered text flushes BEFORE the completion marker…
      ["chat.appendStream", "complete"], // …so the timeline stays in order
      ["chat.stopStream", undefined],
    ]);
    expect(chunkOf(calls[0]!)).toMatchObject({ type: "task_update", id: "c1", title: "Running search", status: "in_progress" });
    expect(chunkOf(calls[1]!)).toMatchObject({ type: "markdown_text", text: "Found it." });
  });

  test("tasks: a tool-only turn posts the timeline (the documented lazy-start departure)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, tasks: (call) => call.name });
    await driveStream(ch2, [
      { type: "action.requested", turnId: "t1", call: { id: "c1", name: "add_reaction", input: {} } } as TurnEvent,
      { type: "action.completed", turnId: "t1", call: { id: "c1", name: "add_reaction", input: {} }, result: {} } as TurnEvent,
      completed(""), // acted via a tool, no text — but the timeline IS content
    ]);
    expect(calls.map(method)).toEqual(["chat.startStream", "chat.appendStream", "chat.stopStream"]);
  });

  test("status: the 'is thinking…' line is set when the turn starts, and the streamed reply auto-clears it", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, status: "is thinking…" });
    await driveStream(ch2, [delta("Hi."), completed("Hi.")]);
    expect(calls.map(method)).toEqual(["assistant.threads.setStatus", "chat.startStream", "chat.stopStream"]); // no explicit clear: posting clears it
    expect(calls[0]!.body).toMatchObject({ channel_id: "C1", thread_ts: "1.1", status: "is thinking…" });
  });

  test("status: a failed turn clears the status instead of leaving it to Slack's timeout (post-once path)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", status: "is thinking…", onError: () => {} });
    await driveStream(ch2, [{ type: "turn.failed", turnId: "t1", error: { message: "boom" } } as TurnEvent]);
    expect(calls.map((c) => [method(c), (c.body as { status?: string }).status])).toEqual([
      ["assistant.threads.setStatus", "is thinking…"],
      ["assistant.threads.setStatus", ""], // the failure posted nothing — nothing auto-clears
    ]);
  });

  test("status: a throwing ctx.run clears the status too (plain run path)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", status: "is thinking…", onError: () => {} });
    const ctx = ctxWith(async () => { throw new Error("boom"); }); // no runStream → plain run path
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    expect(calls.map((c) => [method(c), (c.body as { status?: string }).status])).toEqual([
      ["assistant.threads.setStatus", "is thinking…"],
      ["assistant.threads.setStatus", ""],
    ]);
  });

  test("status: a failed HITL prompt post clears the status (streaming path)", async () => {
    stubSlack((m) => (m === "chat.postMessage" ? { json: { ok: false, error: "channel_not_found" } } : undefined));
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, status: "is thinking…", onError: () => {} });
    await driveStream(ch2, [{ type: "input.requested", turnId: "t1", request: { id: "ok?", prompt: "Proceed?", answererId: "U1" } } as TurnEvent]);
    expect(calls.map((c) => [method(c), (c.body as { status?: string }).status])).toEqual([
      ["assistant.threads.setStatus", "is thinking…"],
      ["chat.postMessage", undefined], // the prompt failed to post (reported via onError)…
      ["assistant.threads.setStatus", ""], // …so nothing would ever auto-clear the status
    ]);
  });

  test("status: a failed HITL prompt post clears the status (post-once path)", async () => {
    stubSlack((m) => (m === "chat.postMessage" ? { json: { ok: false, error: "channel_not_found" } } : undefined));
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", status: "is thinking…", onError: () => {} });
    await driveStream(ch2, [{ type: "input.requested", turnId: "t1", request: { id: "ok?", prompt: "Proceed?", answererId: "U1" } } as TurnEvent]);
    expect(calls.map(method)).toEqual(["assistant.threads.setStatus", "chat.postMessage", "assistant.threads.setStatus"]);
    expect((calls[2]!.body as { status?: string }).status).toBe("");
  });

  test("status: tasks + startStream unavailable + tool-only turn still clears the status", async () => {
    // the task chunk TRIED to open a stream (started=true) but got no ts — nothing ever
    // posts, so nothing auto-clears; `started` alone must not be treated as "posted"
    stubSlack((m) => (m === "chat.startStream" ? { json: { ok: false, error: "unknown_method" } } : undefined));
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, status: "is thinking…", tasks: (c) => c.name, onError: () => {} });
    await driveStream(ch2, [
      { type: "action.requested", turnId: "t1", call: { id: "c1", name: "add_reaction", input: {} } } as TurnEvent,
      { type: "action.completed", turnId: "t1", call: { id: "c1", name: "add_reaction", input: {} }, result: {} } as TurnEvent,
      completed(""),
    ]);
    expect(calls.map((c) => [method(c), (c.body as { status?: string }).status])).toEqual([
      ["assistant.threads.setStatus", "is thinking…"],
      ["chat.startStream", undefined], // the attempt that came back without a ts
      ["assistant.threads.setStatus", ""], // …so the status is cleared explicitly
    ]);
  });

  test("status: a tool-only turn posts nothing, so the status is cleared explicitly", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, status: "is thinking…" });
    await driveStream(ch2, [completed("")]); // acted via a tool; no text, no message
    expect(calls.map((c) => [method(c), (c.body as { status?: string }).status])).toEqual([
      ["assistant.threads.setStatus", "is thinking…"],
      ["assistant.threads.setStatus", ""], // cleared now, not after Slack's 2-minute timeout
    ]);
  });

  test("proactive: channel.deliver renders a turn's stream to a target thread (P4 §9)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    async function* stream() {
      yield { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "cron:daily" } } as TurnEvent;
      yield { type: "message.delta", turnId: "t1", text: "Good " } as TurnEvent;
      yield { type: "message.delta", turnId: "t1", text: "morning." } as TurnEvent;
      yield { type: "turn.completed", turnId: "t1", text: "Good morning." } as TurnEvent;
    }
    await ch2.deliver!({ channelId: "C-ops", threadId: "9.9" }, stream());
    // same renderer as the inbound path — startStream seeds, deltas append, stopStream finalizes,
    // all addressed to the DELIVERY target (not an inbound event's thread).
    expect(calls.map((c) => [method(c), (c.body as { markdown_text?: string }).markdown_text])).toEqual([
      ["chat.startStream", "Good "],
      ["chat.appendStream", "morning."],
      ["chat.stopStream", undefined],
    ]);
    expect((calls[0]!.body as { channel?: string; thread_ts?: string })).toMatchObject({ channel: "C-ops", thread_ts: "9.9" });
  });

  test("proactive: receive() starts an agent-initiated turn (proactive trigger) and delivers it", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    let runArgs: { message: string; opts: unknown } | undefined;
    const ctx = ctxWith(async () => { throw new Error("run() must not be used — receive streams"); });
    ctx.runStream = ((message: string, opts: unknown) => {
      runArgs = { message, opts };
      return (async function* () {
        yield { type: "turn.completed", turnId: "t1", text: "Daily summary posted." } as TurnEvent;
      })();
    }) as typeof ctx.runStream;

    await receive(ch2, ctx, {
      seed: "Summarize today's open threads.",
      target: { channelId: "C-ops" },
      trigger: { kind: "proactive", by: "cron:daily" },
      session: "slack:C-ops:daily",
    });
    // the turn was started FROM the seed, carrying the proactive trigger + the caller's session…
    expect(runArgs!.message).toBe("Summarize today's open threads.");
    expect(runArgs!.opts).toMatchObject({ session: "slack:C-ops:daily", trigger: { kind: "proactive", by: "cron:daily" } });
    // …and its (one-shot) output was delivered to the target.
    expect(calls.map((c) => [method(c), (c.body as { markdown_text?: string }).markdown_text])).toEqual([
      ["chat.startStream", "Daily summary posted."],
      ["chat.stopStream", undefined],
    ]);
  });

  test("proactive: receive() throws clearly when the host can't stream (no silent dropped nudge)", async () => {
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    const ctx = ctxWith(async () => "unused"); // no runStream
    await expect(receive(ch2, ctx, { seed: "x", target: { channelId: "C" }, trigger: { kind: "proactive", by: "cron" }, session: "s" }))
      .rejects.toThrow(/runStream/);
  });

  test("proactive HITL: deliver carries the caller's session into the Approve/Deny value (resume routing)", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    async function* stream() {
      yield { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "cron:daily" } } as TurnEvent;
      yield { type: "input.requested", turnId: "t1", request: { id: "approve-1", prompt: "Post the summary?", answererId: "U1" } } as TurnEvent;
    }
    // a PROACTIVE session is caller-chosen — the click could never re-derive it from the thread
    await ch2.deliver!({ channelId: "C-ops" }, stream(), { session: "slack:C-ops:daily" });
    const post = calls.find((c) => method(c) === "chat.postMessage")!.body as { blocks: { elements?: { value: string }[] }[] };
    expect(JSON.parse(post.blocks[1]!.elements![0]!.value)).toEqual({ turnId: "t1", inputId: "approve-1", input: true, session: "slack:C-ops:daily" });
  });

  test("proactive HITL: a click routes resume to the session NAMED in the value, not the derived thread session", async () => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let resumeArgs: { session?: string } | undefined;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    const ctx = ctxWith(async () => "unused");
    ctx.resumeStream = async function* (o) { resumeArgs = o; yield { type: "turn.completed", turnId: o.turnId, text: "Posted." } as TurnEvent; };

    const value = JSON.stringify({ turnId: "t1", inputId: "approve-1", input: true, session: "slack:C-ops:daily" });
    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C-ops" }, message: { ts: "9.9" }, actions: [{ action_id: "june_input:yes", value }] };
    await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctx);
    await flush();
    expect(resumeArgs!.session).toBe("slack:C-ops:daily"); // NOT slack:C-ops:9.9
  });

  test("HITL: input.requested posts an Approve/Deny message carrying the resume routing value", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () {
      yield { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "x" } } as TurnEvent;
      yield { type: "input.requested", turnId: "t1", request: { id: "approve-1", prompt: "Approve refund?", answererId: "U1" } } as TurnEvent;
    };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "refund", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    const post = calls.find((c) => method(c) === "chat.postMessage")!.body as { blocks: { text?: { text: string }; elements?: { action_id: string; value: string }[] }[] };
    expect(post.blocks[0]!.text!.text).toBe("Approve refund?");
    const buttons = post.blocks[1]!.elements!;
    expect(buttons.map((b) => b.action_id)).toEqual(["june_input:yes", "june_input:no"]);
    // the value names the parked turn's session — the click routes resume by IT, not by re-deriving
    expect(JSON.parse(buttons[0]!.value)).toEqual({ turnId: "t1", inputId: "approve-1", input: true, session: "slack:C1:1.1" });
  });

  test("HITL: a signed block_actions click routes to resumeStream and renders the continuation", async () => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let resumeArgs: unknown;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    const ctx = ctxWith(async () => "unused");
    ctx.resumeStream = async function* (o) { resumeArgs = o; yield { type: "turn.completed", turnId: o.turnId, text: "Refund approved." } as TurnEvent; };

    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9", thread_ts: "5.5" }, actions: [{ action_id: "june_input:yes", value: JSON.stringify({ turnId: "t1", inputId: "approve-1", input: true }) }] };
    const res = await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctx);
    expect(res.status).toBe(200); // fast ACK
    await flush();
    expect(resumeArgs).toEqual({ session: "slack:C1:5.5", turnId: "t1", inputId: "approve-1", input: true, by: "U1" }); // by = the verified clicker
    const updates = calls.filter((c) => method(c) === "chat.update");
    expect(updates.at(-1)!.body).toMatchObject({ channel: "C1", ts: "9.9", text: "Refund approved." }); // rendered into the button message
  });

  test("HITL: post-once (non-stream) mode still posts the Approve/Deny prompt when the turn parks", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" }); // no stream: true
    const ctx = ctxWith(async () => { throw new Error("run() must not be used when runStream is available"); });
    ctx.runStream = async function* () {
      yield { type: "turn.started", turnId: "t1", trigger: { kind: "proactive", by: "x" } } as TurnEvent;
      yield { type: "input.requested", turnId: "t1", request: { id: "approve-1", prompt: "Approve refund?", answererId: "U1" } } as TurnEvent;
    };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "refund", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    const post = calls.find((c) => method(c) === "chat.postMessage")!.body as { blocks?: unknown[]; thread_ts?: string };
    expect(post.blocks).toHaveLength(2); // prompt section + Approve/Deny actions
    expect(post.thread_ts).toBe("1.1"); // threaded, so a click reconstructs the same session
  });

  test("HITL: post-once (non-stream) mode posts a completed turn's text once", async () => {
    streamStub();
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    const ctx = ctxWith(async () => { throw new Error("run() must not be used when runStream is available"); });
    ctx.runStream = async function* () {
      yield { type: "message.delta", turnId: "t1", text: "Hel" } as TurnEvent; // deltas are NOT live-rendered here
      yield { type: "turn.completed", turnId: "t1", text: "Hello" } as TurnEvent;
    };
    await ch2.webhook!(await signed(JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" } })), ctx);
    await flush();
    expect(calls.map(method)).toEqual(["chat.postMessage"]); // one post, no streaming calls
    expect(calls[0]!.body).toMatchObject({ channel: "C1", text: "Hello", thread_ts: "1.1" });
  });

  test("HITL: a rejected click (403/409) leaves the buttons intact and tells only the clicker", async () => {
    captureFetch();
    let reported: unknown;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", onError: (e) => { reported = e; } });
    const ctx = ctxWith(async () => "unused");
    // the DO's /resume answered 403/409 → sseTurnEvents throws before yielding anything
    ctx.resumeStream = async function* () { throw new Error("turn stream: expected an SSE response, got application/json (status 403)"); };
    const interaction = { type: "block_actions", user: { id: "U-other" }, channel: { id: "C1" }, message: { ts: "9.9", thread_ts: "5.5" }, response_url: "https://slack.test/hooks/eph", actions: [{ action_id: "june_input:yes", value: JSON.stringify({ turnId: "t1", inputId: "approve-1", input: true }) }] };
    const res = await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctx);
    expect(res.status).toBe(200);
    await flush();
    expect(calls.filter((c) => method(c) === "chat.update")).toHaveLength(0); // buttons untouched for the rightful answerer
    const eph = calls.find((c) => c.url === "https://slack.test/hooks/eph")!;
    expect(eph.body).toMatchObject({ response_type: "ephemeral", replace_original: false }); // only the clicker is told
    expect((reported as Error).message).toContain("status 403"); // still recorded
  });

  test("HITL: a click on a host without resumeStream reports via onError (not a silent no-op)", async () => {
    captureFetch();
    let reported: unknown;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", onError: (e) => { reported = e; } });
    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9" }, actions: [{ action_id: "june_input:yes", value: JSON.stringify({ turnId: "t1", inputId: "approve-1", input: true }) }] };
    await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctxWith(async () => "unused"));
    await flush();
    expect(calls).toHaveLength(0);
    expect((reported as Error).message).toContain("resumeStream");
  });

  test("HITL: the continuation iterator is closed (return) on completion — no leaked SSE stream", async () => {
    captureFetch();
    let returned = false;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test" });
    const ctx = ctxWith(async () => "unused");
    // a hand-rolled async iterable so we can observe whether the channel calls return() — a manual
    // `for` over next() (not for-await) won't auto-close it, so the finally must do it explicitly.
    ctx.resumeStream = ((o: { turnId: string }) => {
      const events = [{ type: "turn.completed", turnId: o.turnId, text: "Approved." } as TurnEvent];
      let i = 0;
      return { [Symbol.asyncIterator]: () => ({
        next: async () => (i < events.length ? { value: events[i++]!, done: false } : { value: undefined, done: true }),
        return: async () => { returned = true; return { value: undefined, done: true }; },
      }) };
    }) as typeof ctx.resumeStream;
    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9", thread_ts: "5.5" }, actions: [{ action_id: "june_input:yes", value: JSON.stringify({ turnId: "t1", inputId: "approve-1", input: true }) }] };
    await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctx);
    await flush();
    expect(returned).toBe(true); // the SSE-backed stream is torn down, not left dangling
  });

  test("HITL: an action_id that isn't our exact prefix (june_input:*) is ignored", async () => {
    captureFetch();
    let reported: unknown;
    let resumed = false;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", onError: (e) => { reported = e; } });
    const ctx = ctxWith(async () => "unused");
    ctx.resumeStream = async function* () { resumed = true; };
    // "june_input_v2" starts with "june_input" but not "june_input:" — a foreign interactive element
    const interaction = { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9" }, actions: [{ action_id: "june_input_v2", value: JSON.stringify({ x: 1 }) }] };
    await ch2.webhook!(await signed(`payload=${encodeURIComponent(JSON.stringify(interaction))}`), ctx);
    await flush();
    expect(resumed).toBe(false); // not routed to resume
    expect(reported).toBeUndefined(); // and NOT treated as a broken june click
  });

  test("stream render: an iterator exception finalizes the stream and reports via onError", async () => {
    streamStub();
    let reported: unknown;
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", stream: true, onError: (e) => { reported = e; } });
    const ctx = ctxWith(async () => "unused");
    ctx.runStream = async function* () { yield { type: "message.delta", turnId: "t1", text: "Hi" } as TurnEvent; throw new Error("SSE dropped"); };

    const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "order", channel: "C1", ts: "1.1", user: "U1" } });
    await ch2.webhook!(await signed(body), ctx);
    await flush();

    // first token seeds startStream, then the failure note appends, then stopStream — never left open
    expect(calls.map(method)).toEqual(["chat.startStream", "chat.appendStream", "chat.stopStream"]);
    expect((reported as Error).message).toBe("SSE dropped"); // onError still records it
  });

  test("ignores the bot's own message (no reply loop)", async () => {
    captureFetch();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", bot_id: "B1", text: "my own reply", channel: "C1", ts: "1" } });
    await ch.webhook!(await signed(body), ctxWith(async () => "should not run"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("respondTo: a reaction is observed-only while a mention runs a turn + reply", async () => {
    captureFetch();
    const ran: string[] = [];
    const kinds: (string | undefined)[] = [];
    const ch2 = slackChannel({
      signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test",
      events: ["app_mention", "reaction_added"], respondTo: ["app_mention"], botUserId: "UBOT",
      onEvent: (e) => { kinds.push((e.event as { kind?: string } | undefined)?.kind ?? "raw"); },
    });
    async function s(b: string) {
      const ts = String(Math.floor(Date.now() / 1000));
      return new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + (await hmacHex(secret, `v0:${ts}:${b}`)) }, body: b });
    }
    const ctx = ctxWith(async (m) => { ran.push(m); return `re: ${m}`; });
    await ch2.webhook!(await s(JSON.stringify({ type: "event_callback", event: { type: "reaction_added", user: "U2", reaction: "tada", item: { type: "message", channel: "C1", ts: "1.1" } } })), ctx);
    await ch2.webhook!(await s(JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "<@B> hi", channel: "C1", ts: "2.2", user: "U2" } })), ctx);
    await flush();
    expect(ran).toEqual(["<@B> hi"]);                       // only the mention drove a turn
    expect(calls).toHaveLength(1);                          // only the mention replied
    expect(kinds).toEqual(["reaction_added", "app_mention"]); // BOTH were observed
  });

  test("on[kind]: a typed per-kind observer fires with a non-optional event; onEvent sees all (E), events derived (G)", async () => {
    captureFetch();
    const reactions: InboundEvent[] = [];
    const all: (string | undefined)[] = [];
    const ch2 = slackChannel({
      signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", botUserId: "UBOT",
      respondTo: ["app_mention"],                                  // no `events` line → derived (G)
      on: { reaction_added: (e) => { reactions.push(e); } },        // auto-subscribes reaction_added
      onEvent: (e) => { all.push((e.event as { kind?: string } | undefined)?.kind ?? "raw"); },
    });
    async function s(b: string) {
      const ts = String(Math.floor(Date.now() / 1000));
      return new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + (await hmacHex(secret, `v0:${ts}:${b}`)) }, body: b });
    }
    const ctx = ctxWith(async (m) => `re: ${m}`);
    await ch2.webhook!(await s(JSON.stringify({ type: "event_callback", event: { type: "reaction_added", user: "U2", reaction: "tada", item: { type: "message", channel: "C1", ts: "1.1" } } })), ctx);
    await ch2.webhook!(await s(JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hi", channel: "C1", ts: "2.2", user: "U2" } })), ctx);
    await flush();
    expect(reactions).toHaveLength(1);                               // on.reaction_added fired once
    expect(reactions[0]).toMatchObject({ kind: "reaction_added", reaction: { name: "tada" } }); // event non-optional
    expect(all).toEqual(["reaction_added", "app_mention"]);          // onEvent still saw both (both normalized ⇒ subscribed)
    expect(calls).toHaveLength(1);                                   // the mention still replied
  });

  test("G: with respondTo given and events omitted, an unlisted kind is not subscribed (no normalized event, no turn)", async () => {
    captureFetch();
    let ran = false;
    const seen: (string | undefined)[] = [];
    const ch2 = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", respondTo: ["app_mention"], onEvent: (e) => { seen.push((e.event as { kind?: string } | undefined)?.kind ?? "raw"); } });
    async function s(b: string) {
      const ts = String(Math.floor(Date.now() / 1000));
      return new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + (await hmacHex(secret, `v0:${ts}:${b}`)) }, body: b });
    }
    await ch2.webhook!(await s(JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", ts: "3.3", user: "U2" } })), ctxWith(async () => { ran = true; return "x"; }));
    await flush();
    expect(ran).toBe(false);         // "message" not in derived events (only app_mention) → no turn
    expect(seen).toEqual(["raw"]);   // onEvent still fires, but the event wasn't normalized
  });

  test("observe mode: mirrors the event, runs no turn and posts nothing", async () => {
    captureFetch();
    const seen: { raw: unknown; event?: unknown }[] = [];
    let ran = false;
    const shadow = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", mode: "observe", onEvent: (e) => { seen.push(e); } });
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "hello", channel: "C1", ts: "9.9", user: "U1" } });
    async function signedFor(b: string) {
      const ts = String(Math.floor(Date.now() / 1000));
      return new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + (await hmacHex(secret, `v0:${ts}:${b}`)) }, body: b });
    }
    await shadow.webhook!(await signedFor(body), ctxWith(async () => { ran = true; return "x"; }));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toMatchObject({ kind: "message", text: "hello", source: "slack" });
    expect(ran).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an app_mention runs a turn (kind app_mention) and replies in-thread", async () => {
    captureFetch();
    let seen: InboundEvent | undefined;
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "<@B> hi", channel: "C1", ts: "333.3", user: "U2" } });
    const run = (async (m: string, o?: { event?: InboundEvent }) => { seen = o?.event; return `re: ${m}`; }) as ChannelContext["run"];
    await ch.webhook!(await signed(body), ctxWith(run));
    await flush();
    expect(seen).toMatchObject({ kind: "app_mention", channelId: "C1", threadId: "333.3", user: { id: "U2" } });
    expect(calls[0]!.body).toMatchObject({ channel: "C1", text: "re: <@B> hi", thread_ts: "333.3" });
  });

  test("reaction events are ignored by default (not opted in)", async () => {
    captureFetch();
    const body = JSON.stringify({ type: "event_callback", event: { type: "reaction_added", user: "U2", reaction: "tada", item: { type: "message", channel: "C1", ts: "444.4" } } });
    await ch.webhook!(await signed(body), ctxWith(async () => "should not run"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("with reactions opted in, reaction_added runs a turn carrying the emoji + target", async () => {
    captureFetch();
    const reactCh = slackChannel({ signingSecret: secret, botToken: "xoxb", apiUrl: "https://slack.test", events: ["message", "reaction_added"], botUserId: "UBOT" });
    async function signedFor(b: string) {
      const ts = String(Math.floor(Date.now() / 1000));
      return new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + (await hmacHex(secret, `v0:${ts}:${b}`)) }, body: b });
    }
    let seen: InboundEvent | undefined;
    const body = JSON.stringify({ type: "event_callback", event: { type: "reaction_added", user: "U2", reaction: "tada", item: { type: "message", channel: "C1", ts: "444.4" } } });
    const run = (async (_m: string, o?: { event?: InboundEvent }) => { seen = o?.event; return ""; }) as ChannelContext["run"]; // empty reply → no post
    await reactCh.webhook!(await signedFor(body), ctxWith(run));
    await flush();
    expect(seen).toMatchObject({ kind: "reaction_added", channelId: "C1", ts: "444.4", user: { id: "U2" }, reaction: { name: "tada", itemTs: "444.4" } });
    expect(calls).toHaveLength(0); // empty reply is not posted

    // the bot's OWN reaction (user === botUserId) is guarded out
    seen = undefined;
    const own = JSON.stringify({ type: "event_callback", event: { type: "reaction_added", user: "UBOT", reaction: "eyes", item: { type: "message", channel: "C1", ts: "444.4" } } });
    await reactCh.webhook!(await signedFor(own), ctxWith(run));
    await flush();
    expect(seen).toBeUndefined();
  });
});

describe("slackChannel read tools (capability surface)", () => {
  const ch = slackChannel({ signingSecret: "s", botToken: "xoxb", apiUrl: "https://slack.test" });
  const tools = ch.tools!();
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!;
  // the current turn's event — tools default their target from it
  const event: InboundEvent = { source: "slack", kind: "message", channelId: "C1", threadId: "111.1", ts: "111.1", user: { id: "U1" }, raw: {} };
  const ctx = { event } as unknown as ToolContext;

  // fetch stub keyed by Slack method → canned envelope; also records the query
  let seenUrl = "";
  function stub(byMethod: Record<string, unknown>) {
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      const method = seenUrl.split("?")[0]!.split("/").pop()!;
      return new Response(JSON.stringify(byMethod[method] ?? { ok: false, error: "not_stubbed" }), { status: 200 });
    }) as typeof fetch;
  }

  test("exposes the read tools plus slack_add_reaction", () => {
    expect(tools.map((t) => t.spec.name)).toEqual(["slack_read_thread", "slack_list_reactions", "slack_resolve_user", "slack_add_reaction"]);
  });

  test("slack_read_thread defaults to the current thread and normalizes replies", async () => {
    stub({ "conversations.replies": { ok: true, messages: [
      { user: "U1", text: "parent", ts: "111.1" },
      { user: "U2", text: "a reply", ts: "111.2" },
    ] } });
    const out = await tool("slack_read_thread").run({}, ctx);
    expect(seenUrl).toBe("https://slack.test/conversations.replies?channel=C1&ts=111.1");
    expect(out).toEqual({ messages: [
      { user: "U1", text: "parent", ts: "111.1" },
      { user: "U2", text: "a reply", ts: "111.2" },
    ] });
  });

  test("slack_list_reactions returns who reacted with which emoji", async () => {
    stub({ "reactions.get": { ok: true, message: { reactions: [
      { name: "white_check_mark", count: 2, users: ["U1", "U2"] },
      { name: "eyes", count: 1, users: ["U3"] },
    ] } } });
    const out = await tool("slack_list_reactions").run({}, ctx);
    expect(seenUrl).toBe("https://slack.test/reactions.get?channel=C1&timestamp=111.1");
    expect(out).toEqual({ reactions: [
      { name: "white_check_mark", count: 2, users: ["U1", "U2"] },
      { name: "eyes", count: 1, users: ["U3"] },
    ] });
  });

  test("slack_resolve_user defaults to the triggering user and returns names", async () => {
    stub({ "users.info": { ok: true, user: { id: "U1", name: "ada", profile: { real_name: "Ada Lovelace", display_name: "ada" } } } });
    const out = await tool("slack_resolve_user").run({}, ctx);
    expect(seenUrl).toBe("https://slack.test/users.info?user=U1");
    expect(out).toEqual({ id: "U1", name: "ada", realName: "Ada Lovelace", displayName: "ada" });
  });

  test("explicit args override the event; a Slack error is surfaced", async () => {
    stub({ "conversations.replies": { ok: false, error: "channel_not_found" } });
    const out = await tool("slack_read_thread").run({ channelId: "C9", threadId: "9.9" }, ctx);
    expect(seenUrl).toBe("https://slack.test/conversations.replies?channel=C9&ts=9.9");
    expect(out).toEqual({ error: "channel_not_found" });
  });

  test("no target in context and none passed ⇒ a clear error, no fetch", async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    const out = await tool("slack_read_thread").run({}, {} as ToolContext);
    expect(fetched).toBe(false);
    expect(out).toMatchObject({ error: expect.stringContaining("no thread in context") });
  });

  test("slack_add_reaction posts reactions.add, defaulting the target message", async () => {
    let body: unknown;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      seenUrl = String(url); body = init?.body ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const out = await tool("slack_add_reaction").run({ name: "tada" }, ctx);
    expect(seenUrl).toBe("https://slack.test/reactions.add");
    expect(body).toEqual({ channel: "C1", timestamp: "111.1", name: "tada" });
    expect(out).toEqual({ ok: true });
  });

  test("slack_add_reaction treats already_reacted as success (idempotent)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "already_reacted" }), { status: 200 })) as unknown as typeof fetch;
    expect(await tool("slack_add_reaction").run({ name: "tada" }, ctx)).toEqual({ ok: true });
  });

  test("does NOT default from a non-Slack event (cross-channel safety)", async () => {
    // a Crisp event carried into a Slack tool (multi-channel agent) must not be read as
    // Slack ids — the tool requires explicit args instead of firing a garbage call.
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch;
    const crispCtx = { event: { source: "crisp", kind: "message", channelId: "w1", threadId: "s1", ts: "1", raw: {} } } as unknown as ToolContext;
    expect(await tool("slack_read_thread").run({}, crispCtx)).toMatchObject({ error: expect.stringContaining("no thread in context") });
    expect(await tool("slack_list_reactions").run({}, crispCtx)).toMatchObject({ error: expect.stringContaining("no message in context") });
    expect(await tool("slack_resolve_user").run({}, crispCtx)).toMatchObject({ error: expect.stringContaining("no user in context") });
    expect(fetched).toBe(false);
  });
});

describe("exported verify/normalize primitives (D — composability floor)", () => {
  test("verifySlackSignature: fresh+valid true; forged/stale false", async () => {
    const secret = "s", body = "{}";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = "v0=" + (await hmacHex(secret, `v0:${ts}:${body}`));
    expect(await verifySlackSignature(secret, ts, body, sig)).toBe(true);
    expect(await verifySlackSignature(secret, ts, body, "v0=deadbeef")).toBe(false);
    expect(await verifySlackSignature(secret, String(Math.floor(Date.now() / 1000) - 600), body, sig)).toBe(false); // stale
    expect(await verifySlackSignature("", ts, body, sig)).toBe(false); // no secret
  });

  test("verifyCrispSignature, tryParseJson, timestampFresh, normalizeSlackEvent are exported and work", async () => {
    const secret = "k", body = '{"x":1}';
    const ts = String(Date.now()); // crisp = ms
    const sig = await hmacHex(secret, `[${ts};${body}]`);
    expect(await verifyCrispSignature(secret, ts, body, sig)).toBe(true);

    expect(tryParseJson<{ x: number }>(body)).toEqual({ x: 1 });
    expect(tryParseJson("}{ not json")).toBeUndefined();

    expect(timestampFresh(ts)).toBe(true);                                      // ms accepted
    expect(timestampFresh(String(Math.floor(Date.now() / 1000)))).toBe(true);  // seconds accepted
    expect(timestampFresh(String(Date.now() - 600_000))).toBe(false);          // stale

    const norm = normalizeSlackEvent({ type: "message", text: "hi", channel: "C1", ts: "1.1", user: "U1" }, ["message"], undefined);
    expect(norm?.event).toMatchObject({ source: "slack", kind: "message", text: "hi" });
  });
});

describe("resolveChannel (edge factory form)", () => {
  test("passes a plain Channel through; calls a factory with env", () => {
    const plain = defineChannel({ name: "plain" });
    expect(resolveChannel(plain, { X: 1 })).toBe(plain);

    const made = defineChannel({ name: "made" });
    let seen: unknown;
    const factory = (env: unknown) => { seen = env; return made; };
    expect(resolveChannel(factory, { CRISP_SIGNATURE_SECRET: "s" })).toBe(made);
    expect(seen).toEqual({ CRISP_SIGNATURE_SECRET: "s" }); // secrets resolved from env at request time
  });
});

describe("fast-ACK background work uses ctx.waitUntil when present (edge)", () => {
  test("crisp hands the reply-out promise to waitUntil, and awaiting it completes the reply", async () => {
    captureFetch();
    const secret = "sk";
    const ch = crispChannel({ signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test" });
    const held: Promise<unknown>[] = [];
    const ctx: ChannelContext = { ...ctxWith(async (m) => `answer: ${m}`), waitUntil: (p) => { held.push(p); } };

    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "hi", website_id: "w1", session_id: "s1" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await hmacHex(secret, `[${ts};${body}]`);
    const req = new Request("http://x/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": ts, "x-crisp-signature": sig }, body });

    const res = await ch.webhook!(req, ctx);
    expect(res.status).toBe(200);          // fast ACK
    expect(held).toHaveLength(1);          // handed to waitUntil, NOT left floating (would die on the edge)
    await Promise.all(held);               // deterministic settle — no timer
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://crisp.test/website/w1/conversation/s1/message");
    expect(calls[0]!.body).toMatchObject({ content: "answer: hi" });
  });

  test("a throwing onError can't make the background promise reject (edge waitUntil safety)", async () => {
    const secret = "sk";
    const ch = crispChannel({ signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test", onError: () => { throw new Error("handler is broken"); } });
    const held: Promise<unknown>[] = [];
    // the turn itself fails → onError fires → and onError throws
    const ctx: ChannelContext = { ...ctxWith(async () => { throw new Error("turn failed"); }), waitUntil: (p) => { held.push(p); } };

    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "hi", website_id: "w1", session_id: "s1" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await hmacHex(secret, `[${ts};${body}]`);
    const req = new Request("http://x/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": ts, "x-crisp-signature": sig }, body });

    expect((await ch.webhook!(req, ctx)).status).toBe(200);
    expect(held).toHaveLength(1);
    await expect(Promise.all(held)).resolves.toBeDefined(); // settled, did NOT reject despite a throwing onError
  });
});

describe("crispChannel", () => {
  const secret = "sekret";
  const ch = crispChannel({ signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test" });

  async function signed(body: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await hmacHex(secret, `[${ts};${body}]`);
    return new Request("http://x/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": ts, "x-crisp-signature": sig }, body });
  }

  test("a signed visitor message runs a turn and posts the reply via REST", async () => {
    captureFetch();
    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "how many widgets?", website_id: "w1", session_id: "s1" } });
    const res = await ch.webhook!(await signed(body), ctxWith(async (m) => `answer: ${m}`));
    expect(res.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://crisp.test/website/w1/conversation/s1/message");
    expect(calls[0]!.body).toMatchObject({ type: "text", from: "operator", content: "answer: how many widgets?" });
  });

  test("rejects a bad signature with 401", async () => {
    const req = new Request("http://x/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": String(Date.now()), "x-crisp-signature": "nope" }, body: "{}" });
    expect((await ch.webhook!(req, ctxWith(async () => ""))).status).toBe(401);
  });

  test("rejects a stale timestamp with 401 (replay guard — parity with slack)", async () => {
    const oldTs = String(Date.now() - 600_000); // 10 min ago (crisp uses ms)
    const body = "{}";
    const sig = await hmacHex(secret, `[${oldTs};${body}]`); // valid signature, but too old
    const req = new Request("http://x/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": oldTs, "x-crisp-signature": sig }, body });
    expect((await ch.webhook!(req, ctxWith(async () => ""))).status).toBe(401);
  });

  test("a signed but malformed body ACKs 200 (no retry storm), runs nothing", async () => {
    captureFetch();
    const res = await ch.webhook!(await signed("}{ not json"), ctxWith(async () => "should not run"));
    expect(res.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("observe mode: onEvent mirrors visitor AND operator events; no turn, no reply", async () => {
    captureFetch();
    const seen: { raw: unknown; event?: unknown }[] = [];
    let ran = false;
    const shadow = crispChannel({ signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test", mode: "observe", onEvent: (e) => { seen.push(e); } });
    const visitor = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "hi", website_id: "w1", session_id: "s1" } });
    const operator = JSON.stringify({ event: "message:send", data: { from: "operator", type: "text", content: "our reply", website_id: "w1", session_id: "s1" } });
    const ctx = ctxWith(async () => { ran = true; return "nope"; });
    await shadow.webhook!(await signed(visitor), ctx);
    await shadow.webhook!(await signed(operator), ctx);
    await flush();
    expect(seen).toHaveLength(2);                                    // BOTH mirrored (operator too — turn path drops it)
    expect(seen[0]!.event).toMatchObject({ kind: "message", text: "hi", source: "crisp" });
    expect(seen[1]!.event).toBeUndefined();                          // operator: raw only, no normalized envelope
    expect(seen[1]!.raw).toBeDefined();
    expect(ran).toBe(false);                                        // never ran a turn
    expect(calls).toHaveLength(0);                                  // never replied
  });

  test("accept gate: a rejected event ACKs 200 with no onEvent, no turn", async () => {
    captureFetch();
    const seen: unknown[] = [];
    let ran = false;
    const gated = crispChannel({ signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test", accept: (raw) => (raw as { data?: { website_id?: string } }).data?.website_id === "allowed", onEvent: (e) => { seen.push(e); } });
    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "hi", website_id: "blocked", session_id: "s1" } });
    const res = await gated.webhook!(await signed(body), ctxWith(async () => { ran = true; return "x"; }));
    expect(res.status).toBe(200);
    await flush();
    expect(seen).toHaveLength(0);
    expect(ran).toBe(false);
  });

  test("respond mode with onEvent: mirrors AND runs the turn + reply (two background paths)", async () => {
    captureFetch();
    const seen: unknown[] = [];
    const both = crispChannel({ signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test", onEvent: (e) => { seen.push(e); } });
    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "q", website_id: "w1", session_id: "s1" } });
    await both.webhook!(await signed(body), ctxWith(async (m) => `ans: ${m}`));
    await flush();
    expect(seen).toHaveLength(1);                                   // mirrored
    expect(calls).toHaveLength(1);                                  // AND replied
    expect(calls[0]!.body).toMatchObject({ content: "ans: q" });
  });

  test("ignores an operator message (our own reply — no loop)", async () => {
    captureFetch();
    const body = JSON.stringify({ event: "message:send", data: { from: "operator", type: "text", content: "our reply", website_id: "w1", session_id: "s1" } });
    await ch.webhook!(await signed(body), ctxWith(async () => "should not run"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("a whitespace-only visitor message does not run a turn (inbound guard)", async () => {
    captureFetch();
    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "   \n ", website_id: "w1", session_id: "s1" } });
    await ch.webhook!(await signed(body), ctxWith(async () => "should not run"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("an empty reply is not posted (agent acted via a tool — mirrors slack)", async () => {
    captureFetch();
    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "react please", website_id: "w1", session_id: "s1" } });
    await ch.webhook!(await signed(body), ctxWith(async () => "   ")); // whitespace-only reply
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("a visitor message carries a normalized InboundEvent (website/session/user)", async () => {
    let seen: InboundEvent | undefined;
    const body = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "help", website_id: "w1", session_id: "s1", fingerprint: 12345, user: { user_id: "v9", nickname: "Ada" } } });
    const run = (async (_m: string, o?: { event?: InboundEvent }) => { seen = o?.event; return "ok"; }) as ChannelContext["run"];
    await ch.webhook!(await signed(body), ctxWith(run));
    await flush();
    expect(seen).toMatchObject({ kind: "message", channelId: "w1", threadId: "s1", ts: "12345", user: { id: "v9", name: "Ada" }, text: "help" });
  });

  test("normalizeCrispEvent: curated kinds map to typed envelopes; operator/unknown/unlisted → null", () => {
    const all: Parameters<typeof normalizeCrispEvent>[1] = ["message", "message_changed", "state_changed", "rating"];
    // visitor text → message (turn text = the content, verbatim)
    expect(normalizeCrispEvent({ event: "message:send", data: { from: "user", type: "text", content: "hi", website_id: "w1", session_id: "s1", fingerprint: 7 } }, all))
      .toMatchObject({ event: { kind: "message", channelId: "w1", threadId: "s1", ts: "7", text: "hi" }, session: "crisp:w1:s1", userText: "hi" });
    // an edit → message_changed with a synthesized note (crisp sends no `from` here)
    expect(normalizeCrispEvent({ event: "message:updated", data: { content: "hi (edited)", website_id: "w1", session_id: "s1", fingerprint: 7 } }, all))
      .toMatchObject({ event: { kind: "message_changed", text: "hi (edited)" }, userText: "[edited] a message in this conversation was edited to: hi (edited)" });
    // the state machine → state_changed carrying the new state
    expect(normalizeCrispEvent({ event: "session:set_state", data: { state: "resolved", website_id: "w1", session_id: "s1" } }, all))
      .toMatchObject({ event: { kind: "state_changed", state: "resolved" }, session: "crisp:w1:s1", userText: "[state] the conversation was marked resolved" });
    // CSAT → rating riding on event.rating, comment folded into the note
    expect(normalizeCrispEvent({ event: "session:sync:rating", data: { rating: { stars: 2, comment: "slow" }, website_id: "w1", session_id: "s1" } }, all))
      .toMatchObject({ event: { kind: "rating", rating: { stars: 2, comment: "slow" } }, userText: '[rating] the visitor rated this conversation 2/5: "slow"' });
    // loop guard: operator-authored message:send never normalizes
    expect(normalizeCrispEvent({ event: "message:send", data: { from: "operator", type: "text", content: "our reply", website_id: "w1", session_id: "s1" } }, all)).toBeNull();
    // a kind not in `events` doesn't normalize; the long tail never does
    expect(normalizeCrispEvent({ event: "session:sync:rating", data: { rating: { stars: 5 }, website_id: "w1", session_id: "s1" } }, ["message"])).toBeNull();
    expect(normalizeCrispEvent({ event: "campaign:progress", data: {} }, all)).toBeNull();
  });

  test("isCrispEvent narrows an onEvent raw to a typed payload", () => {
    const raw: unknown = { event: "session:sync:rating", data: { rating: { stars: 4 }, website_id: "w1", session_id: "s1" } };
    expect(isCrispEvent(raw, "session:sync:rating") && raw.data.rating?.stars).toBe(4); // typed access, no cast
    expect(isCrispEvent(raw, "message:send")).toBe(false);
    expect(isCrispEvent(null, "message:send")).toBe(false);
  });

  // #91: the envelope is parsed from untrusted JSON — a right event name with a
  // null/missing/scalar `data` must FAIL the guard, not pass it and throw on the
  // first `payload.data.x` access downstream.
  test("isCrispEvent rejects a malformed delivery whose data is not an object (#91)", () => {
    expect(isCrispEvent({ event: "message:send", data: null }, "message:send")).toBe(false);
    expect(isCrispEvent({ event: "message:send" }, "message:send")).toBe(false);
    expect(isCrispEvent({ event: "message:send", data: "corrupted" }, "message:send")).toBe(false);
    expect(isCrispEvent({ event: "message:send", data: 42 }, "message:send")).toBe(false);
    // and the normalizer built on it drops the same deliveries instead of throwing
    expect(normalizeCrispEvent({ event: "message:send", data: undefined }, ["message"])).toBeNull();
    expect(normalizeCrispEvent({ event: "session:sync:rating", data: null }, ["rating"])).toBeNull();
  });

  test("CrispWebhookEnvelope is the exported envelope shape; isCrispEvent narrows within it (#91)", () => {
    // an app types its webhook parse ONCE with the exported envelope instead of re-declaring it
    const envelope: CrispWebhookEnvelope = { website_id: "w1", event: "session:sync:rating", data: { rating: { stars: 2 } }, timestamp: 1 };
    if (isCrispEvent(envelope, "session:sync:rating")) {
      expect(envelope.website_id).toBe("w1"); // envelope fields stay readable after the narrow
      expect(envelope.data.rating?.stars).toBe(2);
    } else {
      throw new Error("expected the guard to pass");
    }
  });

  test("respondTo rating: a CSAT score drives a follow-up turn in the SAME conversation session", async () => {
    captureFetch();
    let turn: { userText: string; session?: string; event?: InboundEvent } | undefined;
    const ch2 = crispChannel({
      signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test",
      respondTo: ["message", "rating"],
    });
    const run = (async (m: string, o?: { session?: string; event?: InboundEvent }) => { turn = { userText: m, session: o?.session, event: o?.event }; return "Sorry about that — I've flagged this."; }) as ChannelContext["run"];
    const body = JSON.stringify({ event: "session:sync:rating", data: { rating: { stars: 1, comment: "unhelpful" }, website_id: "w1", session_id: "s1" } });
    await ch2.webhook!(await signed(body), ctxWith(run));
    await flush();
    expect(turn!.userText).toBe('[rating] the visitor rated this conversation 1/5: "unhelpful"');
    expect(turn!.session).toBe("crisp:w1:s1"); // same session as the conversation's message turns
    expect(turn!.event).toMatchObject({ kind: "rating", rating: { stars: 1 } });
    expect(calls[0]!.url).toBe("https://crisp.test/website/w1/conversation/s1/message"); // reply lands in-conversation
  });

  test("on.rating without respondTo rating: typed observer fires, NO turn (deterministic observe)", async () => {
    captureFetch();
    const seen: InboundEvent[] = [];
    let ran = false;
    const ch2 = crispChannel({
      signingSecret: secret, identifier: "id", key: "key", apiUrl: "https://crisp.test",
      respondTo: ["message"], on: { rating: (e) => { seen.push(e); } },
    });
    const body = JSON.stringify({ event: "session:sync:rating", data: { rating: { stars: 5 }, website_id: "w1", session_id: "s1" } });
    await ch2.webhook!(await signed(body), ctxWith(async () => { ran = true; return "nope"; }));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "rating", rating: { stars: 5 } });
    expect(ran).toBe(false);  // no LLM burn on a score
    expect(calls).toHaveLength(0); // nothing posted back
  });

  test("crisp_read_conversation defaults website/session from the event and normalizes", async () => {
    const tools = ch.tools!();
    const readConvo = tools.find((t) => t.spec.name === "crisp_read_conversation")!;
    expect(tools.map((t) => t.spec.name)).toEqual(["crisp_read_conversation"]);
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ error: false, data: [
        { from: "user", type: "text", content: "hi", user: { nickname: "Ada" } },
        { from: "operator", type: "text", content: "hello" },
      ] }), { status: 200 });
    }) as typeof fetch;
    const ctx = { event: { source: "crisp", kind: "message", channelId: "w1", threadId: "s1", ts: "1", raw: {} } } as unknown as ToolContext;
    const out = await readConvo.run({}, ctx);
    expect(seenUrl).toBe("https://crisp.test/website/w1/conversation/s1/messages");
    expect(out).toEqual({ messages: [
      { from: "user", type: "text", content: "hi", nickname: "Ada" },
      { from: "operator", type: "text", content: "hello", nickname: undefined },
    ] });
  });
});

describe("crispChannel website-hooks auth (urlKey)", () => {
  // Website hooks are unsigned (Crisp docs: "Website Hooks are not signed, in
  // contrary to Plugin Hooks"); the documented contract is a shared key in the
  // endpoint URL. These tests pin that mode; plugin-hook (signature) tests above
  // are the other half of the union.
  const urlCh = crispChannel({ auth: { type: "urlKey", key: "k-123" }, identifier: "id", key: "key", apiUrl: "https://crisp.test" });
  const visitor = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "hi", website_id: "w1", session_id: "s1" } });
  const post = (url: string) => new Request(url, { method: "POST", body: visitor });

  test("a correct ?key runs the turn and replies (no signature headers needed)", async () => {
    captureFetch();
    const res = await urlCh.webhook!(post("http://x/channels/crisp?key=k-123"), ctxWith(async (m) => `answer: ${m}`));
    expect(res.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ content: "answer: hi" });
  });

  test("wrong or missing key → 401, nothing runs", async () => {
    captureFetch();
    const ctx = ctxWith(async () => "should not run");
    expect((await urlCh.webhook!(post("http://x/channels/crisp?key=nope"), ctx)).status).toBe(401);
    expect((await urlCh.webhook!(post("http://x/channels/crisp"), ctx)).status).toBe(401);
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("custom param name", async () => {
    const ch = crispChannel({ auth: { type: "urlKey", key: "k", param: "token" }, identifier: "id", key: "key", apiUrl: "https://crisp.test" });
    expect((await ch.webhook!(post("http://x/channels/crisp?token=k"), ctxWith(async () => ""))).status).toBe(200);
    expect((await ch.webhook!(post("http://x/channels/crisp?key=k"), ctxWith(async () => ""))).status).toBe(401);
  });

  test("empty configured key always 401 (closed-by-default, parity with empty signingSecret)", async () => {
    const ch = crispChannel({ auth: { type: "urlKey", key: "" }, identifier: "id", key: "key", apiUrl: "https://crisp.test" });
    expect((await ch.webhook!(post("http://x/channels/crisp?key="), ctxWith(async () => ""))).status).toBe(401);
  });

  test("construction: both auth and signingSecret throws; neither throws", () => {
    // The opts type forbids both/neither at compile time; the runtime throws are
    // the backstop for plain-JS callers, so cast past the type to reach them.
    // @ts-expect-error — both sources is a compile error by design
    expect(() => crispChannel({ auth: { type: "urlKey", key: "k" }, signingSecret: "s", identifier: "id", key: "key" })).toThrow(/not both/);
    // @ts-expect-error — neither source is a compile error by design
    expect(() => crispChannel({ identifier: "id", key: "key" })).toThrow(/required/);
  });

  test("verifyCrispUrlKey is exported and constant-time-compares the param", () => {
    expect(verifyCrispUrlKey("k", "http://x/hook?key=k")).toBe(true);
    expect(verifyCrispUrlKey("k", "http://x/hook?key=K")).toBe(false);
    expect(verifyCrispUrlKey("", "http://x/hook?key=")).toBe(false);
    expect(verifyCrispUrlKey("k", "http://x/hook?token=k", "token")).toBe(true);
  });

  test("verifyCrispUrlKey fails closed on unparseable URLs and accepts path-relative ones", () => {
    expect(verifyCrispUrlKey("k", "http://[not-a-url")).toBe(false); // never throws
    expect(verifyCrispUrlKey("k", "/hook?key=k")).toBe(true); // path-only (hand-rolled channels)
  });

  test("urlKey mode rejects before reading the body (invalid key leaves the body unread)", async () => {
    const req = post("http://x/channels/crisp?key=nope");
    expect((await urlCh.webhook!(req, ctxWith(async () => ""))).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
  });
});
