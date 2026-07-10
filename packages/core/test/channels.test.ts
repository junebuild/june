// Channel factories + the channelFetch router. The webhook channels verify a
// real HMAC signature (computed here the same way the platform would), fast-ACK,
// run the turn in the background, and post the reply back out — asserted via a
// captured global fetch. Loop guards (self-messages) must NOT trigger a reply.

import { afterEach, describe, expect, test } from "bun:test";
import { channelFetch, defineChannel, resolveChannel, type AgentDefinition, type Channel, type ChannelContext } from "@junejs/core/agent-config";
import type { InboundEvent, ToolContext } from "@junejs/core/agent-runtime";
import { crispChannel, httpChannel, slackChannel } from "@junejs/core/channels";

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

  test("ignores the bot's own message (no reply loop)", async () => {
    captureFetch();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", bot_id: "B1", text: "my own reply", channel: "C1", ts: "1" } });
    await ch.webhook!(await signed(body), ctxWith(async () => "should not run"));
    await flush();
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
    const req = new Request("http://x/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": "1", "x-crisp-signature": "nope" }, body: "{}" });
    expect((await ch.webhook!(req, ctxWith(async () => ""))).status).toBe(401);
  });

  test("ignores an operator message (our own reply — no loop)", async () => {
    captureFetch();
    const body = JSON.stringify({ event: "message:send", data: { from: "operator", type: "text", content: "our reply", website_id: "w1", session_id: "s1" } });
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
