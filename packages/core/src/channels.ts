// channels.ts — built-in channel factories (http / slack / crisp).
//
// Web-standard (Request/Response, crypto.subtle, fetch, TextEncoder, btoa — all
// globals, zero node:*), so they run on native AND edge. Unlike the PoC, these
// are FACTORIES that take secrets as options: the app injects them from its
// environment (process.env on native, env bindings on edge), keeping the channel
// itself portable. An app's agent/channels/slack.ts is then a one-liner:
//   export default slackChannel({ signingSecret: process.env.SLACK_SIGNING_SECRET! , botToken: ... })

import { type Channel, type ChannelContext } from "./agent-config";
import type { InboundEvent, Tool, ToolContext } from "./agent-runtime";

// Re-export the normalized inbound envelope from where channel authors live, so an
// adapter can `import { type InboundEvent } from "@junejs/core/channels"` alongside
// the factories it builds on. Canonical definition lives in agent-runtime (ToolContext
// carries it); this is a convenience re-export at the channel entry point.
export type { InboundEvent } from "./agent-runtime";

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
//
// Beyond replying, the channel gives the agent READ capabilities on the workspace
// via `tools` (merged into agent.tools by defineAgent): read a thread's replies, list
// who reacted with which emoji, resolve a user id to a name. Each tool defaults its
// target — channel / thread / message ts — from the CURRENT turn's InboundEvent
// (ToolContext.event), so the model can call `slack_read_thread` with no arguments and
// get the thread it's already in. All of these need a bot token with the matching
// scopes (channels:history / groups:history, reactions:read, users:read).
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
  // Slack Web API read helper: GET with query params + bearer token. Read methods
  // (conversations.replies, reactions.get, users.info) all accept this shape. Returns
  // the parsed JSON — callers check `ok`/`error` per Slack's envelope.
  async function slackGet(method: string, params: Record<string, string>): Promise<SlackResponse> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${api}/${method}?${qs}`, { headers: { authorization: `Bearer ${opts.botToken}` } });
    return (await res.json()) as SlackResponse;
  }
  async function valid(ts: string, body: string, sig: string): Promise<boolean> {
    if (!opts.signingSecret || !ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5-min replay guard
    return timingSafeEqual("v0=" + (await hmacSha256Hex(opts.signingSecret, `v0:${ts}:${body}`)), sig);
  }
  return {
    name: "slack",
    path: opts.path ?? "/channels/slack",
    tools: () => slackReadTools(slackGet),
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
        event?: { type?: string; bot_id?: string; subtype?: string; text?: string; channel?: string; ts?: string; thread_ts?: string; user?: string };
      };
      if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

      if (payload.type === "event_callback") {
        const e = payload.event ?? {};
        // ignore our own bot + non-user subtypes → no self-reply loop
        if (e.type === "message" && !e.bot_id && !e.subtype && e.text && e.channel && e.ts) {
          const thread = e.thread_ts ?? e.ts; // reply in-thread; one session per thread
          const session = `slack:${e.channel}:${thread}`;
          // The normalized envelope the turn (and its read tools) see: who, where, which
          // thread — so slack_read_thread/list_reactions can default their target.
          const event: InboundEvent = {
            kind: "message",
            channelId: e.channel,
            threadId: thread,
            ts: e.ts,
            user: e.user ? { id: e.user } : undefined,
            text: e.text,
            raw: payload,
          };
          runBackground(ctx, async () => postMessage(e.channel!, await ctx.run(e.text!, { session, event }), thread), opts.onError);
        }
      }
      return new Response("", { status: 200 }); // fast ACK
    },
  };
}

// Slack Web API envelope shape (only the fields the read tools touch). `[k: string]`
// keeps it permissive — Slack returns far more; we normalize just what an agent needs.
type SlackResponse = {
  ok?: boolean;
  error?: string;
  messages?: { user?: string; text?: string; ts?: string; thread_ts?: string; reply_count?: number }[];
  message?: { reactions?: { name: string; count: number; users: string[] }[] };
  user?: { id?: string; name?: string; real_name?: string; profile?: { real_name?: string; display_name?: string } };
};

// The Slack capability toolset. Split out so slackChannel stays readable and the
// tools are unit-testable against a fake `get`. Each tool resolves its target from
// the explicit input first, then falls back to the current turn's event
// (ctx.event) — so the model can omit the ids for "this thread" / "this message".
function slackReadTools(get: (method: string, params: Record<string, string>) => Promise<SlackResponse>): Tool[] {
  const noTarget = (what: string) => ({ error: `no ${what} in context — pass it explicitly (this turn has no Slack event)` });
  return [
    {
      spec: {
        name: "slack_read_thread",
        description: "Read the replies in a Slack thread (defaults to the current thread). Returns each reply's author id, text, and ts.",
        input: {
          type: "object",
          properties: {
            channelId: { type: "string", description: "Channel id; defaults to the current channel" },
            threadId: { type: "string", description: "Thread root ts; defaults to the current thread" },
          },
        },
      },
      run: async (input: { channelId?: string; threadId?: string }, ctx: ToolContext) => {
        const channel = input.channelId ?? ctx.event?.channelId;
        const ts = input.threadId ?? ctx.event?.threadId ?? ctx.event?.ts;
        if (!channel || !ts) return noTarget("thread");
        const r = await get("conversations.replies", { channel, ts });
        if (!r.ok) return { error: r.error ?? "slack error" };
        return { messages: (r.messages ?? []).map((m) => ({ user: m.user, text: m.text, ts: m.ts })) };
      },
    },
    {
      spec: {
        name: "slack_list_reactions",
        description: "List the emoji reactions on a Slack message (defaults to the message that triggered this turn): each reaction's name, count, and the user ids who reacted.",
        input: {
          type: "object",
          properties: {
            channelId: { type: "string", description: "Channel id; defaults to the current channel" },
            ts: { type: "string", description: "Message ts; defaults to the current/reacted message" },
          },
        },
      },
      run: async (input: { channelId?: string; ts?: string }, ctx: ToolContext) => {
        const channel = input.channelId ?? ctx.event?.channelId;
        const ts = input.ts ?? ctx.event?.reaction?.itemTs ?? ctx.event?.ts;
        if (!channel || !ts) return noTarget("message");
        const r = await get("reactions.get", { channel, timestamp: ts });
        if (!r.ok) return { error: r.error ?? "slack error" };
        return { reactions: (r.message?.reactions ?? []).map((x) => ({ name: x.name, count: x.count, users: x.users })) };
      },
    },
    {
      spec: {
        name: "slack_resolve_user",
        description: "Resolve a Slack user id to their name/display name (defaults to the user who triggered this turn).",
        input: {
          type: "object",
          properties: { userId: { type: "string", description: "User id (e.g. U0123); defaults to the current user" } },
        },
      },
      run: async (input: { userId?: string }, ctx: ToolContext) => {
        const user = input.userId ?? ctx.event?.user?.id;
        if (!user) return noTarget("user");
        const r = await get("users.info", { user });
        if (!r.ok) return { error: r.error ?? "slack error" };
        const u = r.user ?? {};
        return { id: u.id ?? user, name: u.name, realName: u.profile?.real_name ?? u.real_name, displayName: u.profile?.display_name };
      },
    },
  ];
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
