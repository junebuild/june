// Channel factories + the channelFetch router. The webhook channels verify a
// real HMAC signature (computed here the same way the platform would), fast-ACK,
// run the turn in the background, and post the reply back out — asserted via a
// captured global fetch. Loop guards (self-messages) must NOT trigger a reply.

import { afterEach, describe, expect, test } from "bun:test";
import { channelFetch, defineChannel, type AgentDefinition, type Channel, type ChannelContext } from "@junejs/core/agent-config";
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
});
