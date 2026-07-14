// channels.ts — built-in channel factories (http / slack / crisp).
//
// Web-standard (Request/Response, crypto.subtle, fetch, TextEncoder, btoa — all
// globals, zero node:*), so they run on native AND edge. Unlike the PoC, these
// are FACTORIES that take secrets as options: the app injects them from its
// environment (process.env on native, env bindings on edge), keeping the channel
// itself portable. An app's agent/channels/slack.ts is then a one-liner:
//   export default slackChannel({ signingSecret: process.env.SLACK_SIGNING_SECRET! , botToken: ... })

import { type Channel, type ChannelContext, type DeliveryTarget } from "./agent-config";
import type { InboundEvent, InputRequest, ProactiveTrigger, Tool, ToolContext, TurnEvent } from "./agent-runtime";

// Re-export the normalized inbound envelope from where channel authors live, so an
// adapter can `import { type InboundEvent } from "@junejs/core/channels"` alongside
// the factories it builds on. Canonical definition lives in agent-runtime (ToolContext
// carries it); this is a convenience re-export at the channel entry point.
export type { InboundEvent } from "./agent-runtime";
// The outbound delivery target for receive()/channel.deliver — re-exported here so a proactive
// caller can type its target alongside the channel factories it imports from this entry point.
export type { DeliveryTarget } from "./agent-config";

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

// ── exported primitives (composability floor) ────────────────────────────────
// Security-critical building blocks, exported so a hand-rolled channel never has to
// re-implement crypto: verify a signed request, then normalize its payload. A fork
// reads the raw body once and calls these — ~30 lines of domain logic, no HMAC of its
// own. `tryParseJson` and `normalizeSlackEvent` (below) round out the set.

// Verify a Slack request signature (v0 = HMAC-SHA256 of "v0:{ts}:{body}") AND its
// freshness (±5 min replay guard). Pass the raw body exactly as received.
export async function verifySlackSignature(signingSecret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  if (!timestampFresh(timestamp)) return false;
  return timingSafeEqual("v0=" + (await hmacSha256Hex(signingSecret, `v0:${timestamp}:${body}`)), signature);
}

// Verify a Crisp plugin hook signature (HMAC-SHA256 of "[{ts};{body}]") + freshness.
export async function verifyCrispSignature(signingSecret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  if (!timestampFresh(timestamp)) return false;
  return timingSafeEqual(await hmacSha256Hex(signingSecret, `[${timestamp};${body}]`), signature);
}

// Re-exported for hand-rolled channels: parse a signed body tolerating malformed input,
// and check a timestamp's freshness. (Definitions above.)
export { tryParseJson, timestampFresh };

// ── channel extension seams (shared by slack + crisp) ─────────────────────────
// An observe/mirror hook: called for EVERY signature-verified inbound webhook event —
// before the turn's loop guard, so it also sees operator/bot/non-text events the turn
// path drops. Runs in the background with the same fast-ACK discipline as the turn
// (its own error swallowed via onError; never blocks the 200). `raw` is the untouched
// platform payload; `event` is the normalized envelope when the event maps to one. This
// is the seam an app uses to mirror a conversation into its own store (a RAG source of
// truth) WITHOUT forking the channel — it inherits all the signature/replay/parse
// hardening for free.
export type ChannelObserver = (e: { raw: unknown; event?: InboundEvent }, ctx: ChannelContext) => Promise<void> | void;

// How the channel treats the agent turn. "respond" (default) = the built-in behavior:
// an eligible user message runs a turn and the reply is posted back. "observe" = shadow
// mode: NEVER run a turn or post a reply — only `onEvent` fires. Pure ingestion, zero
// LLM cost, the channel never talks back to the platform.
export type ChannelMode = "respond" | "observe";

// A typed, single-kind observer (see `on` below): unlike onEvent it fires only for its
// kind and only when a normalized event exists (post bot/loop guards), so `event` is
// non-optional and no `event.kind` demux is needed.
export type KindObserver = (event: InboundEvent, ctx: ChannelContext) => Promise<void> | void;

// The extension opts both channel factories accept, so an app can sit on the built-in
// instead of forking its webhook. `accept` gates a verified event before any work (an
// allowlist lives here) — returning false ACKs 200 and ignores it.
type ChannelExtensions = {
  mode?: ChannelMode;
  accept?: (raw: unknown) => boolean;
  onEvent?: ChannelObserver;
};

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
// A feedback_buttons click, normalized: who rated which streamed reply, tied back to the
// turn/session the buttons were minted with (stopStream embeds them in the button value —
// a PROACTIVE turn's session is caller-chosen and couldn't be re-derived from the thread).
export type SlackFeedback = {
  rating: "positive" | "negative";
  turnId?: string;
  session?: string;
  user?: { id: string };
  channelId?: string;
  threadId?: string;
  messageTs?: string;
};
export function slackChannel(opts: {
  signingSecret: string;
  botToken: string;
  path?: string;
  apiUrl?: string;
  events?: SlackEventKind[];
  // Which of the subscribed `events` actually drive a turn + reply; the rest only reach
  // `onEvent`. Decouples noticing an event from responding to it, per KIND — e.g.
  // events:["app_mention","reaction_added"], respondTo:["app_mention"] runs a turn for a
  // mention but treats a reaction as a deterministic observe (no LLM). Defaults to all of
  // `events` (every subscribed kind responds — the prior behavior). `mode:"observe"`
  // forces this empty (respond to nothing).
  respondTo?: SlackEventKind[];
  // Per-kind observers: `on[kind]` fires (background) only for that kind, only when a
  // normalized event exists — no onEvent-style `event.kind` demux or `event?` guard.
  // Coexists with onEvent (which stays the "observe everything incl. un-normalizable"
  // firehose). A kind present here is auto-subscribed (see the `events` derivation).
  on?: Partial<Record<SlackEventKind, KindObserver>>;
  botUserId?: string;
  // Render the turn LIVE: post a "Thinking…" message, then edit it in place as the turn's
  // events arrive (tool status, then the final answer) instead of posting once at the end.
  // Requires the host to supply ctx.runStream (the edge Durable Object does); falls back to
  // post-once when it's absent.
  stream?: boolean;
  // The agent-era "typing indicator": while a turn runs, show this presence line (e.g.
  // "is thinking…") under the composer via assistant.threads.setStatus. Slack clears it
  // itself the moment the reply posts/streams (with a 2-minute timeout as backstop); a
  // tool-only turn that posts nothing clears it explicitly. Needs the app's Agents & AI
  // Apps feature — elsewhere the call fails harmlessly (best-effort), so it is always safe.
  status?: string;
  // Native 👍/👎 feedback buttons appended when the streamed reply finalizes: chat.stopStream
  // carries a context_actions block holding Slack's purpose-built feedback_buttons element.
  // A click arrives as a block_actions interaction and lands in onFeedback (background,
  // best-effort); the button value ties it back to {turnId, session}. Streaming path only —
  // the postMessage fallback (older app) skips the buttons. Requires stream: true.
  feedback?: boolean;
  onFeedback?: (feedback: SlackFeedback, ctx: ChannelContext) => void | Promise<void>;
  // Render tool calls as Slack's native task timeline INSIDE the streamed message: map a
  // tool call to a ≤256-char task title (return undefined/"" to hide that call). A call
  // shows as in_progress on action.requested and complete on action.completed. NOTE: this
  // makes a tool-only turn post a message (the timeline IS content) — a deliberate departure
  // from the lazy-start rule, which is why it is opt-in. Requires stream: true.
  tasks?: (call: { id: string; name: string; input: unknown }) => string | undefined;
  // How Slack lays the timeline out: sequential "timeline" (Slack's default), grouped
  // "plan", or "dense" (consecutive tool calls collapse into one card). Needs `tasks`.
  taskDisplayMode?: "timeline" | "plan" | "dense";
  onError?: (err: unknown) => void;
} & ChannelExtensions): Channel {
  const api = opts.apiUrl ?? "https://slack.com/api";
  // Derive the subscribe list from intent (respondTo + on keys) so kinds aren't written
  // twice and can't drift; explicit `events` overrides. When the app expresses no intent
  // at all, keep the friendly default (message + app_mention).
  const onKinds = Object.keys(opts.on ?? {}) as SlackEventKind[];
  const events: SlackEventKind[] =
    opts.events ?? (opts.respondTo || opts.on ? [...new Set([...(opts.respondTo ?? []), ...onKinds])] : ["message", "app_mention"]);
  const respondTo: string[] = opts.mode === "observe" ? [] : (opts.respondTo ?? events);
  const authHeaders = { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${opts.botToken}` };
  async function postMessage(channel: string, text: string, thread_ts?: string): Promise<string | undefined> {
    const r = (await (await fetch(`${api}/chat.postMessage`, { method: "POST", headers: authHeaders, body: JSON.stringify({ channel, text, thread_ts }) })).json().catch(() => ({}))) as { ts?: string };
    return r.ts;
  }
  // Slack's native streaming API (chat.startStream/appendStream/stopStream) — purpose-built
  // for token streaming into ONE message: appendStream handles bursts (unlike chat.update's
  // ~1/s whole-message replace). startStream returns the message ts to append/stop against.
  // seed the stream with the first token (markdown_text) — Slack's streaming API expects
  // content, and seeding saves the extra appendStream for that token. Slack also requires an
  // anchor: thread_ts (reply in a thread), or — for a TOP-LEVEL channel message — the
  // recipient's user+team ids (DeliveryTarget.recipientUserId/recipientTeamId).
  // Content is markdown_text OR a chunks array (task_update / plan_update / blocks) — the
  // task timeline rides the same three calls as the text.
  type StreamContent = { markdown_text?: string; chunks?: Record<string, unknown>[] };
  async function startStream(channel: string, thread_ts: string | undefined, content: StreamContent, recipient?: { user?: string; team?: string }): Promise<string | undefined> {
    const body = { channel, thread_ts, ...content, task_display_mode: opts.tasks ? opts.taskDisplayMode : undefined, recipient_user_id: recipient?.user, recipient_team_id: recipient?.team };
    const r = (await (await fetch(`${api}/chat.startStream`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) })).json().catch(() => ({}))) as { ts?: string };
    return r.ts;
  }
  // One append, with a single honored-Retry-After retry on `ratelimited` (Tier 4 allows
  // bursts; two 429s in a row means back off for real — report, don't spin). The error goes
  // back to the renderer: `stopped_by_user` (the human hit Stop) must end rendering, and any
  // other failure must be LOUD — an ignored append silently truncates the message.
  async function appendStream(channel: string, ts: string, content: StreamContent): Promise<{ ok: boolean; error?: string }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${api}/chat.appendStream`, { method: "POST", headers: authHeaders, body: JSON.stringify({ channel, ts, ...content }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok) return { ok: true };
      if (body.error === "ratelimited" && attempt === 0) {
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after") ?? 1) || 0, 10) * 1000));
        continue;
      }
      return { ok: false, error: body.error };
    }
  }
  async function stopStream(channel: string, ts: string, blocks?: unknown[]) {
    await fetch(`${api}/chat.stopStream`, { method: "POST", headers: authHeaders, body: JSON.stringify({ channel, ts, blocks }) });
  }
  // stopStream carries these when opts.feedback is on: one context_actions block holding
  // Slack's native AI feedback buttons. Each button's value ties the click back to
  // {rating, turnId, session} for the june_feedback interaction branch below.
  const feedbackBlocks = (turnId?: string, session?: string) => [{
    type: "context_actions",
    elements: [{
      type: "feedback_buttons",
      action_id: "june_feedback",
      positive_button: { text: { type: "plain_text", text: "Good response" }, value: JSON.stringify({ rating: "positive", turnId, session }) },
      negative_button: { text: { type: "plain_text", text: "Bad response" }, value: JSON.stringify({ rating: "negative", turnId, session }) },
    }],
  }];
  // The "is thinking…" presence line under the composer (assistant.threads.setStatus). Slack
  // clears it itself when the app posts/streams into the thread (2-minute timeout otherwise);
  // an empty status clears it explicitly. Best-effort: outside an AI-app assistant thread the
  // call just fails, and that must never break the turn.
  async function setStatus(channel_id: string, thread_ts: string, status: string) {
    await fetch(`${api}/assistant.threads.setStatus`, { method: "POST", headers: authHeaders, body: JSON.stringify({ channel_id, thread_ts, status }) }).catch(() => {});
  }
  async function updateMessage(channel: string, ts: string, text: string) {
    await fetch(`${api}/chat.update`, { method: "POST", headers: authHeaders, body: JSON.stringify({ channel, ts, text, blocks: [] }) });
  }
  // Post the HITL prompt as a message with Approve / Deny buttons. Each button's value carries
  // the {turnId, inputId, input, session} the interaction handler needs to route session.resume;
  // the action_id prefix `june_input` is how we recognize our own buttons. `session` matters for
  // a PROACTIVE turn: its session is caller-chosen, not the inbound slack:<channel>:<thread>
  // convention, so the click couldn't re-derive it from the message's location.
  async function postApproval(channel: string, thread_ts: string | undefined, turnId: string, request: InputRequest, session?: string): Promise<string | undefined> {
    const btn = (text: string, input: boolean, style: "primary" | "danger") => ({
      type: "button", text: { type: "plain_text", text }, style,
      action_id: `june_input:${input ? "yes" : "no"}`,
      value: JSON.stringify({ turnId, inputId: request.id, input, session }),
    });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: request.prompt } },
      { type: "actions", elements: [btn("Approve", true, "primary"), btn("Deny", false, "danger")] },
    ];
    const r = (await (await fetch(`${api}/chat.postMessage`, { method: "POST", headers: authHeaders, body: JSON.stringify({ channel, thread_ts, text: request.prompt, blocks }) })).json().catch(() => ({}))) as { ok?: boolean; ts?: string };
    // The turn is parked either way — if the prompt didn't post, nobody has buttons to resume
    // it, and that must be loud (onError), not a silently bricked approval.
    if (!r.ok) opts.onError?.(new Error(`slack: failed to post the HITL prompt for input "${request.id}" (turn ${turnId})`));
    return r.ts;
  }
  // Slack caps one markdown_text at 12k chars; longer content is sliced across appends.
  const MD_MAX = 12000;
  // Coalesce token deltas: appendStream is Tier 4 (~100/min + bursts) but a model emits many
  // deltas per second — buffer and flush at most ~2/s (or when a slice fills), so a long turn
  // can't spend the tier while the first token still seeds the stream IMMEDIATELY.
  const FLUSH_MS = 500;
  // Render a turn LIVE via Slack's streaming API: startStream → appendStream each answer-token
  // delta → stopStream. The Slack stream is started LAZILY — only on the first piece of content
  // (a delta, the final one-shot reply, or a failure note) — so a tool-only / empty / no-output
  // turn posts NOTHING (no empty streamed message). When startStream is unavailable (older app),
  // content accumulates and is posted once via chat.postMessage — including a failure note.
  async function streamRender(surface: DeliveryTarget, events: AsyncIterable<TurnEvent>, session?: string) {
    const { channelId, threadId } = surface;
    let streamTs: string | undefined;
    let started = false; // startStream attempted (regardless of success)
    let stoppedByUser = false; // the human hit Slack's Stop — the message is final, cease rendering
    let broken = false; // an append failed hard — keep the tail for a postMessage salvage at finish
    let pending = ""; // deltas awaiting a flush (doubles as the postMessage-fallback accumulator)
    let lastFlush = 0;
    let turnId: string | undefined; // stamped from the first event — the feedback buttons carry it
    if (opts.status && threadId) await setStatus(channelId, threadId, opts.status);
    const recipient = { user: surface.recipientUserId, team: surface.recipientTeamId };
    const flush = async () => {
      if (!pending || stoppedByUser || broken) return;
      if (!started) {
        started = true;
        lastFlush = Date.now();
        const seed = pending.slice(0, MD_MAX); // seed with the first token(s) — the API expects content
        streamTs = await startStream(channelId, threadId, { markdown_text: seed }, recipient);
        if (!streamTs) return; // unavailable → pending rides whole into the postMessage fallback
        pending = pending.slice(seed.length);
      }
      if (!streamTs) return;
      while (pending && !stoppedByUser && !broken) {
        const slice = pending.slice(0, MD_MAX);
        const r = await appendStream(channelId, streamTs, { markdown_text: slice });
        if (r.ok) { pending = pending.slice(slice.length); continue; }
        if (r.error === "stopped_by_user") { stoppedByUser = true; pending = ""; return; } // discard: the human ended it
        broken = true; // `pending` keeps the unsent tail — finish() posts it, nothing silently truncates
        opts.onError?.(new Error(`slack: chat.appendStream failed (${r.error ?? "no response"}) — posting the tail via chat.postMessage`));
      }
      lastFlush = Date.now();
    };
    const push = async (t: string) => {
      if (!t || stoppedByUser) return;
      pending += t;
      if (started && (!streamTs || broken)) return; // fallback/salvage mode: accumulate only, finish() posts it
      if (!started || pending.length >= MD_MAX || Date.now() - lastFlush >= FLUSH_MS) await flush();
    };
    // A task chunk must land in ORDER relative to the text, so buffered text flushes first.
    // A failed chunk is decorative loss: report and carry on (if the stream is actually dead
    // the next text flush notices and salvages); stopped_by_user still ends rendering. The
    // timeline never rides the postMessage fallback — that path is text-only.
    const pushChunk = async (chunk: Record<string, unknown>) => {
      if (stoppedByUser) return;
      await flush();
      if (broken) return;
      if (!started) {
        started = true;
        lastFlush = Date.now();
        streamTs = await startStream(channelId, threadId, { chunks: [chunk] }, recipient); // a chunk can open the stream
        return;
      }
      if (!streamTs) return;
      const r = await appendStream(channelId, streamTs, { chunks: [chunk] });
      if (r.error === "stopped_by_user") { stoppedByUser = true; pending = ""; }
      else if (!r.ok) opts.onError?.(new Error(`slack: task chunk append failed (${r.error ?? "no response"})`));
    };
    const finish = async () => {
      await flush();
      if (stoppedByUser) return; // Slack already closed the stream; appends/stops are refused
      if (streamTs && !broken) await stopStream(channelId, streamTs, opts.feedback ? feedbackBlocks(turnId, session) : undefined);
      if (pending.trim() && (!streamTs || broken)) await postMessage(channelId, pending, threadId);
    };
    try {
      let streamed = false;
      let finalText = "";
      for await (const e of events) {
        if (stoppedByUser) return; // stop rendering; the turn itself runs on host-side
        turnId ??= e.turnId;
        if (e.type === "message.delta") { await push(e.text); streamed = true; }
        else if ((e.type === "action.requested" || e.type === "action.completed") && opts.tasks) {
          // a tool call becomes a native task-timeline entry: in_progress when requested,
          // complete when done. The app's mapper names it (or hides it with undefined/"").
          const title = opts.tasks(e.call);
          if (title) await pushChunk({ type: "task_update", id: e.call.id, title: title.slice(0, 256), status: e.type === "action.requested" ? "in_progress" : "complete" });
        }
        else if (e.type === "turn.completed") finalText = e.text;
        else if (e.type === "turn.failed") { await push("\n_(the turn failed)_"); await finish(); return; }
        else if (e.type === "input.requested") {
          // the turn parked awaiting a human: finalize any streamed text, then post the prompt
          // with Approve/Deny buttons. The interaction handler (below) routes the click to resume.
          if (started) await finish();
          const promptTs = await postApproval(channelId, threadId, e.turnId, e.request, session);
          // the prompt normally auto-clears the status; if it failed to post (reported via
          // onError, not thrown), clear explicitly — nothing else ever will
          if (!promptTs && opts.status && threadId) await setStatus(channelId, threadId, "");
          return; // the stream closed on suspend; the turn continues on the button click
        }
      }
      if (!streamed && finalText.trim()) await push(finalText); // one-shot: the whole reply once
      if (started) await finish(); // nothing pushed (tool-only/empty) ⇒ never started ⇒ post nothing…
      // …but a status was set and nothing will ever post to auto-clear it — clear it now
      // instead of leaving "is thinking…" to Slack's 2-minute timeout.
      else if (opts.status && threadId) await setStatus(channelId, threadId, "");
    } catch (err) {
      await push("\n_(the turn failed)_").catch(() => {}); // starts the stream/buffer if not yet
      await finish().catch(() => {});
      // the failure note normally auto-clears the status — but if even the salvage failed,
      // don't leave "is thinking…" stuck until Slack's 2-minute timeout
      if (opts.status && threadId) await setStatus(channelId, threadId, "").catch(() => {});
      throw err; // let runBackground → onError record it
    }
  }
  // The inbound reply path: render the turn started FROM an event, to that event's own thread.
  function renderStream(ctx: ChannelContext, event: InboundEvent, userText: string, session: string) {
    return streamRender({ channelId: event.channelId, threadId: event.threadId }, ctx.runStream!(userText, { session, event }), session);
  }
  // Post-once render that still understands HITL. The plain ctx.run path collapses the turn
  // to its final text — but a parked turn (input.requested) HAS no final text, so the collapse
  // errors and the Approve/Deny prompt would never post. When the host provides the event
  // stream, consume it non-live instead: post the final text once, post the approval prompt
  // when the turn parks. Failure semantics match ctx.run (throw → runBackground → onError).
  async function renderOnce(ctx: ChannelContext, event: InboundEvent, userText: string, session: string) {
    if (opts.status && event.threadId) await setStatus(event.channelId, event.threadId, opts.status);
    try {
      let finalText = "";
      for await (const e of ctx.runStream!(userText, { session, event })) {
        if (e.type === "turn.completed") finalText = e.text;
        else if (e.type === "turn.failed") throw new Error(e.error.message);
        else if (e.type === "input.requested") {
          const promptTs = await postApproval(event.channelId, event.threadId, e.turnId, e.request, session);
          // a failed prompt post (reported, not thrown) leaves nothing to auto-clear the status
          if (!promptTs && opts.status && event.threadId) await setStatus(event.channelId, event.threadId, "");
          return;
        }
      }
      if (finalText.trim()) await postMessage(event.channelId, finalText, event.threadId);
      else if (opts.status && event.threadId) await setStatus(event.channelId, event.threadId, ""); // tool-only: nothing posts to auto-clear
    } catch (err) {
      // a failed turn posts nothing — clear the status instead of leaving "is thinking…"
      // stuck until Slack's 2-minute timeout
      if (opts.status && event.threadId) await setStatus(event.channelId, event.threadId, "").catch(() => {});
      throw err;
    }
  }
  // Route an Approve/Deny click to session.resume and render the continuation into the button
  // message. The clicker's id is the VERIFIED resumer (`by`) — the signature was checked above,
  // and Slack's payload.user.id is trustworthy; the engine enforces it against answererId.
  function handleInteraction(payload: SlackInteraction, ctx: ChannelContext) {
    if (payload.type !== "block_actions") return;
    const action = payload.actions?.[0];
    // a feedback_buttons click (minted by stopStream): normalize and hand to onFeedback.
    // Nothing to resume and no reply expected — pure telemetry, background + best-effort.
    if (action?.action_id === "june_feedback" && action.value) {
      const fb = tryParseJson<{ rating?: "positive" | "negative"; turnId?: string; session?: string }>(action.value);
      if (fb?.rating && opts.onFeedback) {
        const rating = fb.rating;
        runBackground(ctx, async () => opts.onFeedback!({
          rating, turnId: fb.turnId, session: fb.session,
          user: payload.user?.id ? { id: payload.user.id } : undefined,
          channelId: payload.channel?.id, threadId: payload.message?.thread_ts ?? payload.message?.ts, messageTs: payload.message?.ts,
        }, ctx), opts.onError);
      }
      return;
    }
    if (!action?.action_id?.startsWith("june_input:") || !action.value) return; // not our button (action_ids are june_input:yes|no)
    // From here the click IS ours — a dead end must be loud (onError), never a silent no-op.
    const parsed = tryParseJson<{ turnId: string; inputId: string; input: unknown; session?: string }>(action.value);
    const channel = payload.channel?.id, msgTs = payload.message?.ts;
    const thread = payload.message?.thread_ts ?? msgTs;
    if (!ctx.resumeStream || !parsed || !channel || !thread || !msgTs) {
      opts.onError?.(new Error(ctx.resumeStream
        ? "slack: HITL click with an unusable payload (value/channel/message missing)"
        : "slack: HITL click but the host provides no resumeStream"));
      return;
    }
    // The button value names the parked turn's session (a PROACTIVE session is caller-chosen);
    // fall back to the inbound convention for buttons posted before the value carried it.
    const session = parsed.session ?? `slack:${channel}:${thread}`;
    runBackground(ctx, async () => {
      // Pull the FIRST event before touching the message: the engine rejects an unauthorized
      // clicker (403) or a stale/double click (409) on that first pull, and a rejection must
      // leave the Approve/Deny buttons intact for the rightful answerer.
      const it = ctx.resumeStream!({ session, turnId: parsed.turnId, inputId: parsed.inputId, input: parsed.input, by: payload.user?.id })[Symbol.asyncIterator]();
      let first: IteratorResult<TurnEvent>;
      try {
        first = await it.next();
      } catch (err) {
        // tell only the clicker why nothing happened (response_url posts ephemerally)
        if (payload.response_url) {
          await fetch(payload.response_url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: "This request can't be resumed by you — it may already be answered, or you're not the designated approver." }),
          }).catch(() => {});
        }
        throw err; // still record via onError
      }
      try {
        await updateMessage(channel, msgTs, "_Working…_"); // resume accepted: drop the buttons; show progress
        let final = "";
        for (let r = first; !r.done; r = await it.next()) {
          const ev = r.value;
          if (ev.type === "turn.completed") final = ev.text;
          else if (ev.type === "turn.failed") { await updateMessage(channel, msgTs, "_(the turn failed)_"); return; }
          else if (ev.type === "input.requested") { await postApproval(channel, thread, ev.turnId, ev.request, session); await updateMessage(channel, msgTs, "_(awaiting more input…)_"); return; }
        }
        await updateMessage(channel, msgTs, final.trim() || "_(done)_");
      } catch (err) {
        // the continuation stream dropped mid-flight (the resume itself was accepted)
        await updateMessage(channel, msgTs, "_(the turn failed)_").catch(() => {});
        throw err;
      } finally {
        // Close the manual iterator on every exit (early return on failed/input.requested,
        // normal completion, or a mid-flight throw) so an SSE-backed resumeStream isn't left
        // open — a manual `for` over it.next() won't auto-call return() the way for-await would.
        await it.return?.();
      }
    }, opts.onError);
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
  const valid = (ts: string, body: string, sig: string) => verifySlackSignature(opts.signingSecret, ts, body, sig);
  return {
    name: "slack",
    path: opts.path ?? "/channels/slack",
    tools: () => slackTools(slackGet, slackPost),
    // Proactive delivery (§9): render an agent-initiated turn's stream to a target thread,
    // the same renderer as an inbound reply — progressive edits, HITL prompts, final text.
    // `opts.session` routes an HITL prompt's resume back to the caller-chosen session.
    deliver: (target, events, o) => streamRender(target, events, o?.session),
    async webhook(req, ctx) {
      const body = await req.text();
      const ok = await valid(
        req.headers.get("x-slack-request-timestamp") ?? "",
        body,
        req.headers.get("x-slack-signature") ?? "",
      );
      if (!ok) return new Response("bad signature", { status: 401 });

      // Slack interactivity (a block_actions click on our Approve/Deny buttons) arrives
      // form-encoded as `payload=<json>` — not an Events API JSON body. Route it to resume.
      if (body.startsWith("payload=")) {
        const interaction = tryParseJson<SlackInteraction>(new URLSearchParams(body).get("payload") ?? "");
        if (interaction) handleInteraction(interaction, ctx);
        return new Response("", { status: 200 }); // fast ACK
      }

      const payload = tryParseJson<{ type?: string; challenge?: string; event?: SlackEvent }>(body);
      if (!payload) return new Response("", { status: 200 }); // signed but unparseable → ACK, don't retry
      if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

      if (payload.type === "event_callback") {
        if (opts.accept && !opts.accept(payload)) return new Response("", { status: 200 }); // gated out
        const norm = normalizeSlackEvent(payload.event ?? {}, events, opts.botUserId);
        // observe: mirror EVERY verified event_callback (raw always; normalized when available)
        if (opts.onEvent) runBackground(ctx, async () => opts.onEvent!({ raw: payload, event: norm?.event }, ctx), opts.onError);
        // typed per-kind observer: fires only for its kind, with a non-optional event
        if (norm) {
          const handler = opts.on?.[norm.event.kind as SlackEventKind];
          if (handler) runBackground(ctx, async () => handler(norm.event, ctx), opts.onError);
        }
        // respond: only kinds in respondTo drive a turn + reply (reactions can stay observe-only)
        if (norm && respondTo.includes(norm.event.kind)) {
          const { event, session, userText } = norm;
          runBackground(ctx, async () => {
            if (opts.stream && ctx.runStream) return renderStream(ctx, event, userText, session); // live: edit in place
            if (ctx.runStream) return renderOnce(ctx, event, userText, session); // post-once, HITL-aware
            if (opts.status && event.threadId) await setStatus(event.channelId, event.threadId, opts.status);
            try {
              const reply = await ctx.run(userText, { session, event });
              // A reaction turn (or any turn) may resolve to no text — the agent acted via a
              // tool (e.g. slack_add_reaction) instead of posting. Only post real content.
              if (reply && reply.trim()) await postMessage(event.channelId, reply, event.threadId);
              else if (opts.status && event.threadId) await setStatus(event.channelId, event.threadId, ""); // tool-only: nothing posts to auto-clear
            } catch (err) {
              // a failed turn posts nothing to auto-clear the status — clear it before reporting
              if (opts.status && event.threadId) await setStatus(event.channelId, event.threadId, "").catch(() => {});
              throw err;
            }
          }, opts.onError);
        }
      }
      return new Response("", { status: 200 }); // fast ACK
    },
  };
}

// Start an agent-INITIATED (proactive) turn and render it to a target — the outbound dual of an
// inbound webhook (§9). There is no inbound event: `trigger` attributes who initiated the turn
// (a schedule, another channel, the agent itself), `seed` is the opening instruction the turn
// acts on, and `target` is the thread the reply lands in. A schedule (e.g. a cron), another
// channel handing off, or a tool calls this. Requires a streaming host (ctx.runStream) and a
// channel that renders outbound (channel.deliver) — both present on the edge surface; a missing
// one throws clearly rather than silently dropping a scheduled nudge.
export async function receive(
  channel: Channel,
  ctx: ChannelContext,
  opts: { seed: string; target: DeliveryTarget; trigger: ProactiveTrigger; session: string; turnId?: string },
): Promise<void> {
  if (!ctx.runStream) throw new Error("receive: the host provides no runStream — proactive delivery needs a streaming target (the edge Durable Object)");
  if (!channel.deliver) throw new Error(`receive: channel "${channel.name}" has no deliver() — it can't render an agent-initiated turn`);
  const events = ctx.runStream(opts.seed, { session: opts.session, turnId: opts.turnId, trigger: opts.trigger });
  await channel.deliver(opts.target, events, { session: opts.session });
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

// The subset of a Slack block_actions interaction payload we read (a button click).
// `response_url` lets us answer the CLICKER ephemerally (e.g. a rejected resume) without
// touching the message the buttons live on.
type SlackInteraction = {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: { action_id?: string; value?: string }[];
  response_url?: string;
};

// Map a raw Slack event to June's normalized envelope + the turn's session and text.
// Returns null when the event isn't one we route (not in `events`, self-authored, or
// missing required fields) so the webhook simply fast-ACKs and does nothing. Exported so
// a hand-rolled Slack channel can reuse the normalization instead of re-deriving it.
export function normalizeSlackEvent(
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

// ── crisp — customer-chat: webhooks in, REST out. Crisp has TWO webhook
// contracts and they authenticate differently:
//
//   - PLUGIN hooks (Marketplace) are signed: HMAC-SHA256 over "[{ts};{rawBody}]"
//     (brackets + semicolon included) plus a timestamp replay guard. Use
//     auth: { type: "signature", secret } — or the signingSecret shorthand.
//   - WEBSITE hooks (dashboard-configured) are NOT signed. Crisp's documented
//     pattern is a shared key in the endpoint URL ("?key=K"); the receiver
//     compares it. Use auth: { type: "urlKey", key }. This is weaker by
//     construction (no payload integrity, no replay guard, and the key rides in
//     the URL where access logs and proxies can see it — rotate it if logs leak)
//     — that's the platform's ceiling for website hooks, not a choice this
//     channel makes.
//
// Only visitor ("user") text triggers a turn by default; operator messages are our own
// replies. `respondTo` widens that (a rating or a resolve can drive a follow-up turn).
//
// Symmetric with slack: the visitor message becomes a normalized InboundEvent
// (channelId = website, threadId = conversation session, user = the visitor), and the
// channel exposes crisp_read_conversation so the agent can pull earlier messages in the
// same conversation — defaulting the target from the current turn's event.
//
// ⚠️ Which events ARRIVE at all is decided in Crisp's dashboard/Marketplace (the hook's
// event checkboxes), not here — `events`/`respondTo`/`on` only filter what arrives. The
// most common "why doesn't my observer fire" is the box not being ticked on the Crisp
// side. Dashboard checkbox ↔ this channel:
//   message:send          → kind "message"          (visitor text; the default turn driver)
//   message:updated       → kind "message_changed"
//   session:set_state     → kind "state_changed"    (resolved / unresolved / pending)
//   session:sync:rating   → kind "rating"           (CSAT stars + comment)
//   message:received, message:removed, session:removed, people:* → no normalized kind;
//   they reach onEvent with a TYPED raw payload (see CrispEventPayloads / isCrispEvent).
// Note: website hooks expose a SUBSET of Crisp's full catalog (no session:request:initiated,
// no session:set_opened/closed, no message:compose:*) — design flows against session:set_state,
// which both hook flavors deliver.
export type CrispWebhookAuth =
  | { type: "signature"; secret: string }
  | { type: "urlKey"; key: string; param?: string };

// Website-hook verifier (exported for the same composability floor as
// verifyCrispSignature): constant-time compare of the URL param (default
// "key") against the configured key. An empty configured key always fails —
// same closed-by-default posture as an empty signing secret. Accepts absolute
// or path-relative URLs; anything unparseable fails closed (return false, never
// throw) — same contract as the signature verifiers on bad input.
export function verifyCrispUrlKey(expectedKey: string, url: string, param = "key"): boolean {
  if (!expectedKey) return false;
  let params: URLSearchParams;
  try {
    params = new URL(url, "http://relative.invalid").searchParams;
  } catch {
    return false;
  }
  return timingSafeEqual(params.get(param) ?? "", expectedKey);
}

// Exactly one of `auth` / `signingSecret`, enforced at the type level so a
// misconfigured channel is a compile error, not a runtime 401 — signingSecret is
// the plugin-hook shorthand, kept for compatibility: it means
// { type: "signature", secret }. (The constructor re-checks at runtime as a
// backstop for plain-JS callers.)
type CrispAuthOpts =
  | { auth: CrispWebhookAuth; signingSecret?: never }
  | { auth?: never; signingSecret: string };

// ── crisp typed payloads + normalization ──────────────────────────────────────
// Curated `data` shapes for the dashboard-subscribable events an agent app actually
// consumes — typed so an onEvent consumer gets autocomplete and typo-checking instead
// of hand-rolling shapes from the Crisp docs. Deliberately NOT the full ~70-event
// catalog: the long tail (campaign:*, bucket:*, email:*, …) stays `unknown` and is
// still reachable through onEvent's raw. All fields optional — Crisp payloads are
// external input; normalization (below) is where required fields are enforced.
export type CrispMessageType = "text" | "file" | "animation" | "audio" | "picker" | "field" | "carousel" | "note" | "event";
export type CrispUser = { user_id?: string; nickname?: string };
type CrispMessageData = {
  website_id?: string; session_id?: string; from?: "user" | "operator"; type?: CrispMessageType;
  content?: unknown; fingerprint?: number; user?: CrispUser; timestamp?: number;
};
export type CrispEventPayloads = {
  "message:send": CrispMessageData;     // a visitor message (the default turn driver)
  "message:received": CrispMessageData; // an operator message (our own replies included — loop hazard, never a turn)
  "message:updated": { website_id?: string; session_id?: string; fingerprint?: number; content?: unknown };
  "message:removed": { website_id?: string; session_id?: string; fingerprint?: number };
  "session:set_state": { website_id?: string; session_id?: string; state?: "pending" | "unresolved" | "resolved" };
  "session:sync:rating": { website_id?: string; session_id?: string; rating?: { stars?: number; comment?: string } };
  "session:removed": { website_id?: string; session_id?: string };
};
export type CrispEventName = keyof CrispEventPayloads;

// Narrow an onEvent `raw` to a typed Crisp payload:
//   if (isCrispEvent(raw, "session:sync:rating")) record(raw.data.rating?.stars)
// Checks only the discriminant — the data shape is a trusted-typing convenience, the
// same posture as every other webhook payload cast in this module.
export function isCrispEvent<E extends CrispEventName>(
  payload: unknown,
  event: E,
): payload is { event: E; data: CrispEventPayloads[E]; timestamp?: number } {
  return typeof payload === "object" && payload !== null && (payload as { event?: unknown }).event === event;
}

// The normalized kinds crispChannel can produce (a subset of InboundEvent["kind"]).
export type CrispEventKind = "message" | "message_changed" | "state_changed" | "rating";

// Map a raw Crisp webhook payload to June's normalized envelope + the turn's session and
// text — the crisp dual of normalizeSlackEvent, exported so a hand-rolled channel reuses
// the normalization. Returns null when the event isn't one we route (not in `events`,
// operator/self-authored, or missing required fields) so the webhook fast-ACKs and does
// nothing. Kinds without natural text (state_changed / rating) synthesize a note as the
// userText — same pattern as Slack reaction turns.
export function normalizeCrispEvent(
  payload: { event?: string; data?: unknown },
  events: CrispEventKind[],
): { event: InboundEvent; session: string; userText: string } | null {
  const base = (d: { website_id?: string; session_id?: string }) =>
    ({ source: "crisp", channelId: d.website_id!, threadId: d.session_id!, raw: payload }) as const;
  const session = (d: { website_id?: string; session_id?: string }) => `crisp:${d.website_id}:${d.session_id}`; // one conversation = one session

  // A VISITOR text message (operator messages — message:received, or a message:send that
  // isn't visitor-authored — are our own reply path → loop guard; require non-blank content so
  // a whitespace message doesn't burn a turn). channelId = website, threadId = conversation
  // session (NOT ts — Crisp keys a conversation by website/session; ts is just the message
  // fingerprint, "" when Crisp omits it).
  if (isCrispEvent(payload, "message:send") && events.includes("message")) {
    const d = payload.data ?? {};
    if (d.from === "user" && d.type === "text" && typeof d.content === "string" && d.content.trim() && d.website_id && d.session_id) {
      return {
        event: { ...base(d), kind: "message", ts: String(d.fingerprint ?? ""), user: d.user?.user_id ? { id: d.user.user_id, name: d.user.nickname } : undefined, text: d.content },
        session: session(d),
        userText: d.content,
      };
    }
    return null;
  }
  // A message edit. ⚠️ Crisp's payload carries NO `from` — visitor and operator edits are
  // indistinguishable, so putting "message_changed" in respondTo can burn a turn on an
  // operator's own edit. Fine for observers; opt into turns knowingly.
  if (isCrispEvent(payload, "message:updated") && events.includes("message_changed")) {
    const d = payload.data ?? {};
    if (typeof d.content === "string" && d.content.trim() && d.website_id && d.session_id) {
      return {
        event: { ...base(d), kind: "message_changed", ts: String(d.fingerprint ?? ""), text: d.content },
        session: session(d),
        userText: `[edited] a message in this conversation was edited to: ${d.content}`,
      };
    }
    return null;
  }
  // The conversation's state machine (resolved / unresolved / pending) — the hook both
  // website and plugin hooks deliver for "the operator resolved it" (session:set_closed
  // does NOT reach website hooks). The natural trigger for a resolve hand-off.
  if (isCrispEvent(payload, "session:set_state") && events.includes("state_changed")) {
    const d = payload.data ?? {};
    if (d.state && d.website_id && d.session_id) {
      return {
        event: { ...base(d), kind: "state_changed", ts: "", state: d.state },
        session: session(d),
        userText: `[state] the conversation was marked ${d.state}`,
      };
    }
    return null;
  }
  // The visitor's CSAT rating — stars (+ optional comment) ride on event.rating so a
  // follow-up turn (respondTo: ["rating"]) can react to a bad score.
  if (isCrispEvent(payload, "session:sync:rating") && events.includes("rating")) {
    const d = payload.data ?? {};
    if (typeof d.rating?.stars === "number" && d.website_id && d.session_id) {
      return {
        event: { ...base(d), kind: "rating", ts: "", rating: { stars: d.rating.stars, comment: d.rating.comment } },
        session: session(d),
        userText: `[rating] the visitor rated this conversation ${d.rating.stars}/5${d.rating.comment ? `: "${d.rating.comment}"` : ""}`,
      };
    }
    return null;
  }
  return null;
}

export function crispChannel(opts: CrispAuthOpts & {
  identifier: string;
  key: string;
  path?: string;
  apiUrl?: string;
  // Which arriving events NORMALIZE (become an InboundEvent) — "message" (visitor text)
  // by default. Same derivation as slack: expressing intent via respondTo/on derives the
  // list; explicit `events` overrides. Remember the dashboard checkbox decides what
  // arrives at all (see the header note) — this only filters.
  events?: CrispEventKind[];
  // Which normalized kinds drive a turn + reply; the rest only reach `on`/`onEvent`.
  // Defaults to all of `events` (mode:"observe" forces this empty). e.g.
  // events:["message","rating"], respondTo:["message"] runs a turn per visitor message
  // but treats a CSAT rating as a deterministic observe (no LLM); respondTo:["message",
  // "rating"] lets a bad score drive a follow-up turn (userText is a synthesized note,
  // like Slack reaction turns).
  respondTo?: CrispEventKind[];
  // Per-kind observers: `on[kind]` fires (background) only for that kind, only when a
  // normalized event exists (post loop guards) — no onEvent-style demux. A kind present
  // here is auto-subscribed (see the `events` derivation). onEvent stays the raw
  // firehose over ALL verified events, normalizable or not.
  on?: Partial<Record<CrispEventKind, KindObserver>>;
  onError?: (err: unknown) => void;
} & ChannelExtensions): Channel {
  const api = opts.apiUrl ?? "https://api.crisp.chat/v1";
  // Derive the normalize list from intent (respondTo + on keys) so kinds aren't written
  // twice and can't drift; explicit `events` overrides. No intent at all → the friendly
  // default (visitor messages only — the prior behavior).
  const onKinds = Object.keys(opts.on ?? {}) as CrispEventKind[];
  const events: CrispEventKind[] =
    opts.events ?? (opts.respondTo || opts.on ? [...new Set([...(opts.respondTo ?? []), ...onKinds])] : ["message"]);
  const respondTo: string[] = opts.mode === "observe" ? [] : (opts.respondTo ?? events);
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
  // Resolve the auth mode once, loudly: a channel that silently 401s every
  // delivery because neither source was configured is much harder to diagnose
  // than a construction-time throw.
  if (opts.auth && opts.signingSecret !== undefined)
    throw new Error("crispChannel: pass either `auth` or `signingSecret`, not both");
  const webhookAuth: CrispWebhookAuth | undefined =
    opts.auth ?? (opts.signingSecret !== undefined ? { type: "signature", secret: opts.signingSecret } : undefined);
  if (!webhookAuth) throw new Error("crispChannel: one of `auth` or `signingSecret` is required");
  return {
    name: "crisp",
    path: opts.path ?? "/channels/crisp",
    tools: () => crispTools(crispGet),
    async webhook(req, ctx) {
      // urlKey authenticates from the URL alone — reject before reading the body,
      // so an invalid-key request costs a URL parse and nothing else. Signature
      // mode MACs the raw body, so it has to read first.
      if (webhookAuth.type === "urlKey" && !verifyCrispUrlKey(webhookAuth.key, req.url, webhookAuth.param))
        return new Response("bad key", { status: 401 });
      const body = await req.text();
      if (webhookAuth.type === "signature") {
        const ok = await verifyCrispSignature(
          webhookAuth.secret,
          req.headers.get("x-crisp-request-timestamp") ?? "",
          body,
          req.headers.get("x-crisp-signature") ?? "",
        );
        if (!ok) return new Response("bad signature", { status: 401 });
      }

      const payload = tryParseJson<{ event?: string; data?: unknown }>(body);
      if (!payload) return new Response("", { status: 200 }); // signed but unparseable → ACK, don't retry
      if (opts.accept && !opts.accept(payload)) return new Response("", { status: 200 }); // gated out (e.g. website allowlist)

      const norm = normalizeCrispEvent(payload, events);

      // observe: mirror EVERY verified event (visitor + operator + non-text) — this is how
      // an app records the whole conversation without forking the channel. Narrow `raw`
      // with isCrispEvent for typed access to the un-normalized kinds (message:received…).
      if (opts.onEvent) runBackground(ctx, async () => opts.onEvent!({ raw: payload, event: norm?.event }, ctx), opts.onError);
      // typed per-kind observer: fires only for its kind, with a non-optional event
      if (norm) {
        const handler = opts.on?.[norm.event.kind as CrispEventKind];
        if (handler) runBackground(ctx, async () => handler(norm.event, ctx), opts.onError);
      }

      // respond: only kinds in respondTo drive a turn + reply (a rating can stay observe-only).
      if (norm && respondTo.includes(norm.event.kind)) {
        const { event, session, userText } = norm;
        runBackground(ctx, async () => {
          const reply = await ctx.run(userText, { session, event });
          if (reply && reply.trim()) await sendMessage(event.channelId, event.threadId!, reply); // skip empty (tool-only turn)
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
