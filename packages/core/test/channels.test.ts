// Channel factories + the channelFetch router. The webhook channels verify a
// real HMAC signature (computed here the same way the platform would), fast-ACK,
// run the turn in the background, and post the reply back out — asserted via a
// captured global fetch. Loop guards (self-messages) must NOT trigger a reply.

import { afterEach, describe, expect, test } from "bun:test";
import { channelFetch, defineChannel, resolveChannel, type AgentDefinition, type Channel, type ChannelContext } from "@junejs/core/agent-config";
import type { InboundEvent, ToolContext, TurnEvent } from "@junejs/core/agent-runtime";
import { crispChannel, httpChannel, slackChannel, verifySlackSignature, verifyCrispSignature, tryParseJson, timestampFresh, normalizeSlackEvent } from "@junejs/core/channels";

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
    expect(JSON.parse(buttons[0]!.value)).toEqual({ turnId: "t1", inputId: "approve-1", input: true });
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
