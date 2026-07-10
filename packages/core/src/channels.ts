// channels.ts — built-in channel factories (http / slack / crisp).
//
// Web-standard (Request/Response, crypto.subtle, fetch, TextEncoder, btoa — all
// globals, zero node:*), so they run on native AND edge. Unlike the PoC, these
// are FACTORIES that take secrets as options: the app injects them from its
// environment (process.env on native, env bindings on edge), keeping the channel
// itself portable. An app's agent/channels/slack.ts is then a one-liner:
//   export default slackChannel({ signingSecret: process.env.SLACK_SIGNING_SECRET! , botToken: ... })

import { type Channel, type ChannelContext } from "./agent-config";

const enc = new TextEncoder();

// A webhook ACKs fast (within the platform's timeout) and does the real work — run
// the turn, post the reply back — AFTER responding. That trailing promise must
// survive the response: on the edge the host supplies `ctx.waitUntil` (keeps the
// isolate alive); on native there is none and a floating promise runs to completion
// on its own. Either way `.catch` routes failures to onError so nothing rejects
// unhandled.
function runBackground(ctx: ChannelContext, work: () => Promise<unknown>, onError?: (err: unknown) => void): void {
  // Promise.resolve().then(work) so even a SYNCHRONOUS throw from work (a non-async
  // work fn) turns into a rejection the .catch below handles — the fast-ACK path must
  // never see an exception escape. (Both built-in callers are async today, so this is
  // defensive completeness for any future work shape, not a live bug.)
  const p = Promise.resolve()
    .then(work)
    .catch((err) => {
      // A broken app-supplied onError must NOT destabilize the ACK path either: if it
      // throws, an edge waitUntil task would fail and a native floating promise would
      // become an unhandled rejection. Swallow it so this promise can truly never reject.
      try { onError?.(err); } catch { /* error reporting failed — nothing more to do */ }
    });
  ctx.waitUntil?.(p);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare (equal lengths only) — avoids leaking the MAC via
// timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// ── http — a generic Web channel: POST /message runs a turn; optionally serve
// /mcp (pass your app's mcpHandler) so the same directory is also an MCP server.
export function httpChannel(opts: { path?: string; mcp?: (req: Request) => Promise<Response> } = {}): Channel {
  const messagePath = opts.path ?? "/message";
  return {
    name: "http",
    fetch(ctx) {
      return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        if (opts.mcp && url.pathname === "/mcp") return opts.mcp(req);
        if (url.pathname === messagePath && req.method === "POST") {
          const { message, session } = (await req.json()) as { message: string; session?: string };
          return Response.json({ text: await ctx.run(message, { session }) });
        }
        return new Response(`${ctx.agent.name} — POST ${messagePath}`, { status: 404 });
      };
    },
  };
}

// ── slack — Events API inbound (signed) → durable turn → chat.postMessage out.
// Slack signs each request v0=HMAC-SHA256("v0:{ts}:{rawBody}"). Fast-ACK within
// 3s and run the turn in the background; the bot_id/subtype guard prevents the
// agent replying to itself.
export function slackChannel(opts: {
  signingSecret: string;
  botToken: string;
  path?: string;
  apiUrl?: string;
  onError?: (err: unknown) => void;
}): Channel {
  const api = opts.apiUrl ?? "https://slack.com/api";
  async function postMessage(channel: string, text: string, thread_ts?: string) {
    await fetch(`${api}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${opts.botToken}` },
      body: JSON.stringify({ channel, text, thread_ts }),
    });
  }
  async function valid(ts: string, body: string, sig: string): Promise<boolean> {
    if (!opts.signingSecret || !ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5-min replay guard
    return timingSafeEqual("v0=" + (await hmacSha256Hex(opts.signingSecret, `v0:${ts}:${body}`)), sig);
  }
  return {
    name: "slack",
    path: opts.path ?? "/channels/slack",
    async webhook(req, ctx) {
      const body = await req.text();
      const ok = await valid(
        req.headers.get("x-slack-request-timestamp") ?? "",
        body,
        req.headers.get("x-slack-signature") ?? "",
      );
      if (!ok) return new Response("bad signature", { status: 401 });

      const payload = JSON.parse(body) as {
        type?: string;
        challenge?: string;
        event?: { type?: string; bot_id?: string; subtype?: string; text?: string; channel?: string; ts?: string; thread_ts?: string };
      };
      if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

      if (payload.type === "event_callback") {
        const e = payload.event ?? {};
        // ignore our own bot + non-user subtypes → no self-reply loop
        if (e.type === "message" && !e.bot_id && !e.subtype && e.text && e.channel) {
          const thread = e.thread_ts ?? e.ts; // reply in-thread; one session per thread
          const session = `slack:${e.channel}:${thread}`;
          runBackground(ctx, async () => postMessage(e.channel!, await ctx.run(e.text!, { session }), thread), opts.onError);
        }
      }
      return new Response("", { status: 200 }); // fast ACK
    },
  };
}

// ── crisp — customer-chat: signed webhooks in, REST out. Crisp signs plugin
// hooks HMAC-SHA256 over "[{ts};{rawBody}]" (brackets + semicolon included). Only
// visitor ("user") text triggers a turn; operator messages are our own replies.
export function crispChannel(opts: {
  signingSecret: string;
  identifier: string;
  key: string;
  path?: string;
  apiUrl?: string;
  onError?: (err: unknown) => void;
}): Channel {
  const api = opts.apiUrl ?? "https://api.crisp.chat/v1";
  async function sendMessage(websiteId: string, sessionId: string, content: string) {
    const auth = btoa(`${opts.identifier}:${opts.key}`);
    await fetch(`${api}/website/${websiteId}/conversation/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}`, "X-Crisp-Tier": "plugin" },
      body: JSON.stringify({ type: "text", from: "operator", origin: "chat", content }),
    });
  }
  async function valid(ts: string, body: string, sig: string): Promise<boolean> {
    if (!opts.signingSecret || !ts || !sig) return false;
    return timingSafeEqual(await hmacSha256Hex(opts.signingSecret, `[${ts};${body}]`), sig);
  }
  return {
    name: "crisp",
    path: opts.path ?? "/channels/crisp",
    async webhook(req, ctx) {
      const body = await req.text();
      const ok = await valid(
        req.headers.get("x-crisp-request-timestamp") ?? "",
        body,
        req.headers.get("x-crisp-signature") ?? "",
      );
      if (!ok) return new Response("bad signature", { status: 401 });

      const payload = JSON.parse(body) as {
        event?: string;
        data?: { from?: string; type?: string; content?: unknown; website_id?: string; session_id?: string };
      };
      const d = payload.data ?? {};
      // only a VISITOR text message; operator messages are our own reply (loop guard)
      if (payload.event === "message:send" && d.from === "user" && d.type === "text" && d.content && d.website_id && d.session_id) {
        const session = `crisp:${d.website_id}:${d.session_id}`; // one conversation = one session
        runBackground(ctx, async () => sendMessage(d.website_id!, d.session_id!, await ctx.run(String(d.content), { session })), opts.onError);
      }
      return new Response("", { status: 200 }); // fast ACK
    },
  };
}
