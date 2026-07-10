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

// Parse a webhook body that has ALREADY passed signature verification, tolerating a
// malformed payload. A signed-but-unparseable body is authentic yet permanently
// unprocessable (retrying yields the same bytes), so the caller ACKs 200 and drops it
// rather than throwing — an uncaught throw here would surface as a 5xx and make the
// platform (Slack/Crisp) redeliver the same broken event forever.
function tryParseJson<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

// Replay/freshness guard: reject a request whose timestamp is more than 5 minutes from
// now. `ts` may be epoch seconds (Slack) or milliseconds (Crisp), so normalize by
// magnitude — a value past ~1e11 can only be milliseconds (1e11 s ≈ year 5138).
function timestampFresh(ts: string, toleranceSec = 300): boolean {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return false;
  const tsSec = n > 1e11 ? n / 1000 : n;
  return Math.abs(Date.now() / 1000 - tsSec) <= toleranceSec;
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
// Beyond replying, the channel gives the agent READ + WRITE capabilities on the
// workspace via `tools` (merged into agent.tools by defineAgent): read a thread's
// replies, list who reacted with which emoji, resolve a user id to a name, and add a
// reaction. Each tool defaults its target — channel / thread / message ts — from the
// CURRENT turn's InboundEvent (ToolContext.event), so the model can call
// `slack_read_thread` with no arguments and get the thread it's already in. These need
// a bot token with the matching scopes (channels:history / groups:history,
// reactions:read, reactions:write, users:read).
//
// `events` selects which inbound events become turns: message + app_mention by default
// (a text turn). Add "reaction_added"/"reaction_removed" to have the agent react when
// someone adds/removes an emoji (opt-in — most apps don't want a turn per reaction). A
// reaction turn carries no text, so a synthesized note ("<@U> added :tada:") is the
// userText and the reaction target rides on event.reaction. `botUserId` is the loop
// guard for reactions: with it set, the bot's OWN reactions (e.g. from slack_add_reaction)
// don't trigger a turn — the bot_id/subtype guard already covers self-messages.
export type SlackEventKind = "message" | "app_mention" | "reaction_added" | "reaction_removed";
export function slackChannel(opts: {
  signingSecret: string;
  botToken: string;
  path?: string;
  apiUrl?: string;
  events?: SlackEventKind[];
  botUserId?: string;
  onError?: (err: unknown) => void;
}): Channel {
  const api = opts.apiUrl ?? "https://slack.com/api";
  const events = opts.events ?? ["message", "app_mention"];
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
  // Slack Web API write helper: POST JSON + bearer token (reactions.add, …).
  async function slackPost(method: string, params: Record<string, string>): Promise<SlackResponse> {
    const res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${opts.botToken}` },
      body: JSON.stringify(params),
    });
    return (await res.json()) as SlackResponse;
  }
  async function valid(ts: string, body: string, sig: string): Promise<boolean> {
    if (!opts.signingSecret || !ts || !sig) return false;
    if (!timestampFresh(ts)) return false; // 5-min replay guard
    return timingSafeEqual("v0=" + (await hmacSha256Hex(opts.signingSecret, `v0:${ts}:${body}`)), sig);
  }
  return {
    name: "slack",
    path: opts.path ?? "/channels/slack",
    tools: () => slackTools(slackGet, slackPost),
    async webhook(req, ctx) {
      const body = await req.text();
      const ok = await valid(
        req.headers.get("x-slack-request-timestamp") ?? "",
        body,
        req.headers.get("x-slack-signature") ?? "",
      );
      if (!ok) return new Response("bad signature", { status: 401 });

      const payload = tryParseJson<{ type?: string; challenge?: string; event?: SlackEvent }>(body);
      if (!payload) return new Response("", { status: 200 }); // signed but unparseable → ACK, don't retry
      if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

      if (payload.type === "event_callback") {
        const norm = normalizeSlackEvent(payload.event ?? {}, events, opts.botUserId);
        if (norm) {
          const { event, session, userText } = norm;
          runBackground(ctx, async () => {
            const reply = await ctx.run(userText, { session, event });
            // A reaction turn (or any turn) may resolve to no text — the agent acted via a
            // tool (e.g. slack_add_reaction) instead of posting. Only post real content.
            if (reply && reply.trim()) await postMessage(event.channelId, reply, event.threadId);
          }, opts.onError);
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

// The subset of a Slack Events API `event` we read. message/app_mention carry text;
// reaction_added/removed carry `reaction` + `item` (the message reacted to).
type SlackEvent = {
  type?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
};

// Map a raw Slack event to June's normalized envelope + the turn's session and text.
// Returns null when the event isn't one we route (not in `events`, self-authored, or
// missing required fields) so the webhook simply fast-ACKs and does nothing.
function normalizeSlackEvent(
  e: SlackEvent,
  events: SlackEventKind[],
  botUserId?: string,
): { event: InboundEvent; session: string; userText: string } | null {
  // text turns: a channel message or an @-mention. Skip our own bot + non-user subtypes,
  // and blank text (a whitespace-only message shouldn't burn a turn).
  if ((e.type === "message" || e.type === "app_mention") && events.includes(e.type) && !e.bot_id && !e.subtype && e.text && e.text.trim() && e.channel && e.ts) {
    const thread = e.thread_ts ?? e.ts; // reply in-thread; one session per thread
    return {
      event: { source: "slack", kind: e.type, channelId: e.channel, threadId: thread, ts: e.ts, user: e.user ? { id: e.user } : undefined, text: e.text, raw: e },
      session: `slack:${e.channel}:${thread}`,
      userText: e.text,
    };
  }
  // reaction turns: someone added/removed an emoji on a message. No text, so synthesize
  // a note as the userText; the target rides on event.reaction (itemTs). botUserId guards
  // the bot's own reactions (from slack_add_reaction) so they don't loop into a turn.
  if ((e.type === "reaction_added" || e.type === "reaction_removed") && events.includes(e.type) && e.reaction && e.item?.channel && e.item?.ts) {
    if (botUserId && e.user === botUserId) return null;
    const channel = e.item.channel, itemTs = e.item.ts;
    const verb = e.type === "reaction_added" ? "added" : "removed";
    return {
      event: { source: "slack", kind: e.type, channelId: channel, threadId: itemTs, ts: itemTs, user: e.user ? { id: e.user } : undefined, reaction: { name: e.reaction, itemTs }, raw: e },
      session: `slack:${channel}:${itemTs}`,
      userText: `[reaction] <@${e.user ?? "someone"}> ${verb} :${e.reaction}: on a message in this thread`,
    };
  }
  return null;
}

// The Slack capability toolset. Split out so slackChannel stays readable and the
// tools are unit-testable against fake `get`/`post`. Each tool resolves its target
// from the explicit input first, then falls back to the current turn's event — so the
// model can omit the ids for "this thread" / "this message".
//
// The fallback is gated on `event.source === "slack"`: tools are merged GLOBALLY into
// an agent (defineAgent), so a multi-channel agent has slack_* tools available during a
// Crisp turn too. Without the gate, a Slack tool called mid-Crisp-turn would read the
// Crisp event's channelId/threadId and fire a garbage Slack call. Gating on the event's
// source (not sessionId — which is "self" inside a Durable Object) is reliable on native
// AND edge: a non-Slack turn simply requires explicit ids.
// A Slack Web API call (GET read or POST write) — same signature, so one type serves
// both the `get` (query) and `post` (JSON body) helpers passed in.
type SlackCall = (method: string, params: Record<string, string>) => Promise<SlackResponse>;
function slackTools(get: SlackCall, post: SlackCall): Tool[] {
  const noTarget = (what: string) => ({ error: `no ${what} in context — pass it explicitly (this turn has no Slack event)` });
  const slackEv = (ctx: ToolContext) => (ctx.event?.source === "slack" ? ctx.event : undefined);
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
        const ev = slackEv(ctx);
        const channel = input.channelId ?? ev?.channelId;
        const ts = input.threadId ?? ev?.threadId ?? ev?.ts;
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
        const ev = slackEv(ctx);
        const channel = input.channelId ?? ev?.channelId;
        const ts = input.ts ?? ev?.reaction?.itemTs ?? ev?.ts;
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
        const user = input.userId ?? slackEv(ctx)?.user?.id;
        if (!user) return noTarget("user");
        const r = await get("users.info", { user });
        if (!r.ok) return { error: r.error ?? "slack error" };
        const u = r.user ?? {};
        return { id: u.id ?? user, name: u.name, realName: u.profile?.real_name ?? u.real_name, displayName: u.profile?.display_name };
      },
    },
    {
      spec: {
        name: "slack_add_reaction",
        description: "Add an emoji reaction to a Slack message (defaults to the message that triggered this turn). Give the emoji name without colons, e.g. 'tada' or 'white_check_mark'.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Emoji name without colons (e.g. thumbsup)" },
            channelId: { type: "string", description: "Channel id; defaults to the current channel" },
            ts: { type: "string", description: "Message ts; defaults to the current/reacted message" },
          },
          required: ["name"],
        },
      },
      run: async (input: { name: string; channelId?: string; ts?: string }, ctx: ToolContext) => {
        const ev = slackEv(ctx);
        const channel = input.channelId ?? ev?.channelId;
        const ts = input.ts ?? ev?.reaction?.itemTs ?? ev?.ts;
        if (!channel || !ts) return noTarget("message");
        const r = await post("reactions.add", { channel, timestamp: ts, name: input.name });
        // already_reacted isn't a failure for an agent — treat it as success (idempotent).
        if (!r.ok && r.error !== "already_reacted") return { error: r.error ?? "slack error" };
        return { ok: true };
      },
    },
  ];
}

// ── crisp — customer-chat: signed webhooks in, REST out. Crisp signs plugin
// hooks HMAC-SHA256 over "[{ts};{rawBody}]" (brackets + semicolon included). Only
// visitor ("user") text triggers a turn; operator messages are our own replies.
//
// Symmetric with slack: the visitor message becomes a normalized InboundEvent
// (channelId = website, threadId = conversation session, user = the visitor), and the
// channel exposes crisp_read_conversation so the agent can pull earlier messages in the
// same conversation — defaulting the target from the current turn's event.
export function crispChannel(opts: {
  signingSecret: string;
  identifier: string;
  key: string;
  path?: string;
  apiUrl?: string;
  onError?: (err: unknown) => void;
}): Channel {
  const api = opts.apiUrl ?? "https://api.crisp.chat/v1";
  const auth = () => `Basic ${btoa(`${opts.identifier}:${opts.key}`)}`;
  async function sendMessage(websiteId: string, sessionId: string, content: string) {
    await fetch(`${api}/website/${websiteId}/conversation/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth(), "X-Crisp-Tier": "plugin" },
      body: JSON.stringify({ type: "text", from: "operator", origin: "chat", content }),
    });
  }
  async function crispGet(path: string): Promise<CrispResponse> {
    const res = await fetch(`${api}${path}`, { headers: { authorization: auth(), "X-Crisp-Tier": "plugin" } });
    return (await res.json()) as CrispResponse;
  }
  async function valid(ts: string, body: string, sig: string): Promise<boolean> {
    if (!opts.signingSecret || !ts || !sig) return false;
    if (!timestampFresh(ts)) return false; // 5-min replay guard (parity with slack)
    return timingSafeEqual(await hmacSha256Hex(opts.signingSecret, `[${ts};${body}]`), sig);
  }
  return {
    name: "crisp",
    path: opts.path ?? "/channels/crisp",
    tools: () => crispTools(crispGet),
    async webhook(req, ctx) {
      const body = await req.text();
      const ok = await valid(
        req.headers.get("x-crisp-request-timestamp") ?? "",
        body,
        req.headers.get("x-crisp-signature") ?? "",
      );
      if (!ok) return new Response("bad signature", { status: 401 });

      const payload = tryParseJson<{
        event?: string;
        data?: { from?: string; type?: string; content?: unknown; website_id?: string; session_id?: string; fingerprint?: number; user?: { user_id?: string; nickname?: string } };
      }>(body);
      if (!payload) return new Response("", { status: 200 }); // signed but unparseable → ACK, don't retry
      const d = payload.data ?? {};
      // only a VISITOR text message; operator messages are our own reply (loop guard).
      // require non-blank content — a whitespace-only message shouldn't burn a turn.
      if (payload.event === "message:send" && d.from === "user" && d.type === "text" && typeof d.content === "string" && d.content.trim() && d.website_id && d.session_id) {
        const session = `crisp:${d.website_id}:${d.session_id}`; // one conversation = one session
        // channelId = website, threadId = conversation session → crisp_read_conversation
        // defaults its target from these (NOT ts — Crisp keys a conversation by
        // website/session; ts is just the message fingerprint, "" when Crisp omits it).
        const event: InboundEvent = {
          source: "crisp",
          kind: "message",
          channelId: d.website_id,
          threadId: d.session_id,
          ts: String(d.fingerprint ?? ""),
          user: d.user?.user_id ? { id: d.user.user_id, name: d.user.nickname } : undefined,
          text: String(d.content),
          raw: payload,
        };
        runBackground(ctx, async () => {
          const reply = await ctx.run(String(d.content), { session, event });
          // don't post an empty operator message when the agent acted via a tool (mirror slack)
          if (reply && reply.trim()) await sendMessage(d.website_id!, d.session_id!, reply);
        }, opts.onError);
      }
      return new Response("", { status: 200 }); // fast ACK
    },
  };
}

// Crisp REST envelope (only what the read tool touches). Crisp wraps payloads in
// `{ error, data }`; message objects carry from/type/content/timestamp.
type CrispResponse = {
  error?: boolean;
  reason?: string;
  data?: { from?: string; type?: string; content?: unknown; timestamp?: number; user?: { nickname?: string; user_id?: string } }[];
};

// The Crisp capability toolset — symmetric with slackTools. crisp_read_conversation
// pulls the message history of a conversation, defaulting website/session from the
// current turn's event (channelId/threadId).
function crispTools(get: (path: string) => Promise<CrispResponse>): Tool[] {
  return [
    {
      spec: {
        name: "crisp_read_conversation",
        description: "Read the earlier messages in this Crisp conversation (defaults to the current conversation). Returns each message's sender (user/operator), type, and content.",
        input: {
          type: "object",
          properties: {
            websiteId: { type: "string", description: "Website id; defaults to the current one" },
            sessionId: { type: "string", description: "Conversation session id; defaults to the current one" },
          },
        },
      },
      run: async (input: { websiteId?: string; sessionId?: string }, ctx: ToolContext) => {
        // gate on source: in a multi-channel agent this tool is available during a Slack
        // turn too; only default from a genuine Crisp event (see slackTools for the why).
        const ev = ctx.event?.source === "crisp" ? ctx.event : undefined;
        const website = input.websiteId ?? ev?.channelId;
        const session = input.sessionId ?? ev?.threadId;
        if (!website || !session) return { error: "no conversation in context — pass websiteId and sessionId (this turn has no Crisp event)" };
        const r = await get(`/website/${website}/conversation/${session}/messages`);
        if (r.error) return { error: r.reason ?? "crisp error" };
        return { messages: (r.data ?? []).map((m) => ({ from: m.from, type: m.type, content: m.content, nickname: m.user?.nickname })) };
      },
    },
  ];
}
