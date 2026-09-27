---
title: "Channels: where turns come in"
nav: "Channels"
description: A channel is an agent's inbound edge — a signed webhook or fetch handler in agent/channels/*.ts that verifies the platform, resolves who is speaking, runs a turn, and posts the reply back.
date: 2026-09-27
section: Agents
order: "16.2"
sources: [packages/core/src/channels.ts, packages/core/src/agent-config.ts, packages/core/src/agent-runtime.ts, packages/june/src/agent-discover.ts, examples/slack-agent/worker.ts, examples/slack-agent/README.md, examples/slack-feedback-agent/worker.ts, examples/agent-edge/agent/channels/crisp.ts, packages/core/CHANGELOG.md]
---
## The shape

Each file in `agent/channels/*.ts` default-exports either a `Channel` or a
factory `(env) => Channel`. Use the factory on Cloudflare: secrets only exist in
`env` inside an invocation, never at module scope, so the host calls the
factory with its env (`process.env` on native, the worker/DO bindings on edge).

```ts
// agent/channels/slack.ts
import { slackChannel } from "@junejs/core/channels";

export default (env: { SLACK_SIGNING_SECRET: string; SLACK_BOT_TOKEN: string }) =>
  slackChannel({
    signingSecret: env.SLACK_SIGNING_SECRET,
    botToken: env.SLACK_BOT_TOKEN,
    stream: true,
    status: "is thinking…",
  });
```

Channels are pure transport. A webhook channel owns a `path` (`/channels/slack`,
`/channels/crisp` by default), verifies the signature, ACKs fast, and runs the
turn in the background (kept alive with `ctx.waitUntil` on the edge). A channel
can also contribute `tools` — they are merged into the agent's tool list, and a
duplicate tool name fails assembly.

## Identity: from platform sender to `ctx.user`

The platform's claimed sender lands on `event.user` and is untrusted. A
`resolveIdentity` hook maps verified evidence to your own `Principal`; the
result is pinned on `event.principal` before any observer or turn runs, flows
to `ToolContext.principal`, and reaches a `defineAction` as `ctx.user` — the
same field a UI POST or `/mcp` call carries. Tools marked `requiresPrincipal`
stay hidden on anonymous turns.

- **Slack** — sender ids arrive inside the signature-verified payload, so there
  is no extra fetch. The resolver gets `{ userId, teamId, senderTeamId,
  channelId, threadId, kind, ts }`. `teamId` is the *envelope* workspace, not
  proof of membership (Slack Connect users arrive under it too): before
  granting staff roles, check an allowlist or `users.info`.
- **Crisp** — webhook user fields are client-writable hints, so the channel
  *pulls* the conversation's identity-verification evidence over authenticated
  REST (one GET per normalized event). Only `sdk`/`api` email verifications
  count as `verified`; a failed lookup arrives as `{ fetched: false, verified:
  false }`.

```ts
slackChannel({
  signingSecret, botToken,
  resolveIdentity: ({ userId }) => (userId && STAFF.has(userId) ? { id: userId, role: "staff" } : null),
});
```

Both are fail-closed: a throwing resolver is reported to `onError` and the turn
runs anonymous.

## httpChannel

A generic web endpoint: `POST` to `path` (default `/message`) with
`{ message, session? }` and get `{ text }` back. Pass `mcp` (your app's MCP
handler) to also serve `/mcp` from the same channel.

```ts
import { httpChannel } from "@junejs/core/channels";

export default httpChannel({ path: "/message" });
```

```bash
curl -X POST https://<host>/message -d '{"message":"hello","session":"s1"}'
# → {"text":"…"}
```

## slackChannel

Required: `signingSecret` (verifies `v0=HMAC-SHA256` plus a ±5-minute replay
window) and `botToken` (`xoxb-…`). Point both **Event Subscriptions** and
**Interactivity** Request URLs at `https://<host>/channels/slack`; the channel
answers `url_verification` itself.

**Rendering.** By default the reply is posted once. `stream: true` streams it
into one message via `chat.startStream` / `appendStream` / `stopStream`
(falls back to post-once when the host has no `runStream`). `status: "is
thinking…"` shows Slack's presence line under the composer while the turn runs
(needs the Agents & AI Apps feature; fails harmlessly elsewhere).

**Pre-tool text.** With `stream: true`, text a model writes before calling a
tool ("Let me search the docs…") streams into the answer. Set
`intermediateText: "status"` to render it as progress instead — a task-timeline
entry when `tasks` is on, else the status line — so only the final step's text
is the answer. The trade-off: each step is held until it ends, so the answer
appears whole rather than token by token.

**Which events do what.**

```ts
slackChannel({
  signingSecret, botToken,
  botUserId: env.SLACK_BOT_USER_ID,         // loop guard for the bot's own reactions
  respondTo: ["app_mention"],               // these kinds run a turn + reply
  on: {                                     // typed per-kind observers, no LLM
    reaction_added: (e, ctx) => record(e),
    reaction_removed: (e, ctx) => record(e),
  },
  onEvent: ({ raw, event }, ctx) => mirror(raw), // every verified event_callback
});
```

- `events` — kinds that normalize: `"message" | "app_mention" |
  "reaction_added" | "reaction_removed"`. Defaults to `["message",
  "app_mention"]`, or is derived from `respondTo` + `on` keys when you set
  those.
- `respondTo` — which of `events` drive a turn (default: all of them).
- `mode: "observe"` — never run a turn or post; only `on` / `onEvent` fire.
- Reaction turns carry no text: the user text is a synthesized note and the
  target rides on `event.reaction`.
- `accept(raw)` gates a verified event before any work; `onRejected` reports
  deliveries turned away (`bad_signature`, `malformed_body`,
  `unrouted_interaction`).

**Redelivery dedup.** Slack retries an event with the same `event_id` when it
doesn't see a 2xx within 3 s. The channel remembers handled ids per mount path
(10 minutes, up to 5,000) and ACKs a repeat before anything — observers
included — runs. It is per isolate, so a retry landing on another edge isolate
isn't caught; dropped repeats show up in `diagnose().counters.duplicates`.

**Approvals (HITL).** When a tool calls `ctx.requestInput({ id, prompt })`, the
turn parks and the channel posts the prompt with **Approve / Deny** buttons.
The click arrives on the same endpoint (Interactivity must be on), and the
clicker's verified Slack id resumes the turn — checked against `answererId`,
which defaults to the user who triggered it. A rejected click leaves the
buttons in place and tells the clicker ephemerally. `approvalConfirm: true`
adds Slack's confirmation dialog. Works with and without `stream`.

**Agent tools.** Mounting the channel gives the agent four tools. Each defaults
its target from the current Slack event, so the model can call them with no
arguments:

| tool | Slack API | scope |
|---|---|---|
| `slack_read_thread` | `conversations.replies` | `channels:history` / `groups:history` |
| `slack_list_reactions` | `reactions.get` | `reactions:read` |
| `slack_resolve_user` | `users.info` | `users:read` |
| `slack_add_reaction` | `reactions.add` | `reactions:write` |

Also available: `feedback` / `onFeedback` (native 👍/👎 on streamed replies),
`tasks` (tool calls as a task timeline), `replaceInFlight` (a new message
supersedes the thread's running turn), `onInteraction` (your own buttons on the
same endpoint), and `diagnose()` — checks the token, the granted scopes against
the enabled features, and per-kind delivery counters.

## crispChannel

```ts
// agent/channels/crisp.ts
import { crispChannel } from "@junejs/core/channels";

export default (env: { CRISP_SIGNATURE_SECRET: string; CRISP_IDENTIFIER: string; CRISP_KEY: string }) =>
  crispChannel({
    signingSecret: env.CRISP_SIGNATURE_SECRET, // plugin hooks; or auth: { type: "urlKey", key } for website hooks
    identifier: env.CRISP_IDENTIFIER,
    key: env.CRISP_KEY,
    replyAs: "note",                           // supervised rollout: replies go to operators only
  });
```

- Auth: exactly one of `signingSecret` (plugin hooks, HMAC over
  `[{ts};{body}]` + replay guard) or `auth` (`{ type: "signature", secret }` or
  `{ type: "urlKey", key, param? }` for unsigned website hooks). Neither, or
  both, throws at construction.
- `tier` — `"plugin"` (default) or `"website"`, sent as `X-Crisp-Tier`.
- `events` / `respondTo` / `on` / `onEvent` / `mode` / `accept` work as in
  Slack, over `"message" | "message_changed" | "state_changed" | "rating"`.
  Default: visitor text messages only. Which events *arrive* is set by the hook
  checkboxes in Crisp, not here.
- Tools: `crisp_read_conversation` and `crisp_send_note`.

**Private notes** are Crisp messages of type `note` — only human operators see
them. Three ways to write one: the agent calls `crisp_send_note` mid-turn;
`replyAs: "note"` sends every reply as a note; or your code calls
`channel.post(target, { text, note: true })`. All of it fails closed, so
operator-only text never leaks to the visitor by accident: a `replyAs` other
than `"message"` / `"note"` throws at construction, a non-boolean `note`
throws on `post`, and Slack's `post` rejects `note: true` outright since Slack
has no private notes. Model-supplied website/session ids are encoded as single
path segments, and `.` / `..` are rejected.

## Custom channels

`defineChannel` (from `@junejs/core/agent-config`) types a hand-rolled channel.
Don't re-implement the crypto — the security primitives are exported from
`@junejs/core/channels`: `verifySlackSignature`, `verifyCrispSignature`,
`verifyCrispUrlKey`, `normalizeSlackEvent`, `normalizeCrispEvent`,
`tryParseJson`, `timestampFresh`.

```ts
// agent/channels/slack-lite.ts
import { defineChannel } from "@junejs/core/agent-config";
import { normalizeSlackEvent, tryParseJson, verifySlackSignature } from "@junejs/core/channels";

type Payload = { type?: string; challenge?: string; team_id?: string; event?: Parameters<typeof normalizeSlackEvent>[0] };

export default (env: { SLACK_SIGNING_SECRET: string }) =>
  defineChannel({
    name: "slack",
    path: "/channels/slack-lite",
    async webhook(req, ctx) {
      const body = await req.text(); // the raw body, exactly as received
      const ok = await verifySlackSignature(
        env.SLACK_SIGNING_SECRET,
        req.headers.get("x-slack-request-timestamp") ?? "",
        body,
        req.headers.get("x-slack-signature") ?? "",
      );
      if (!ok) return new Response("bad signature", { status: 401 });
      const payload = tryParseJson<Payload>(body);
      if (!payload) return new Response("", { status: 200 }); // signed but unparseable: ACK, don't retry
      if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });
      const norm = normalizeSlackEvent(payload.event ?? {}, ["app_mention"], undefined, payload.team_id);
      if (norm) {
        const work = ctx
          .run(norm.userText, { session: norm.session, event: norm.event })
          .then((reply) => postReply(norm.event, reply)) // your outbound call
          .catch(console.error);
        ctx.waitUntil?.(work); // keep the isolate alive past the ACK on the edge
      }
      return new Response("", { status: 200 });
    },
  });
```

## Per-surface policy

The channel carries no behavior. How the agent acts *when reached over Slack*
lives at the agent level, keyed by `event.source` (the channel name —
`"slack"`, `"crisp"`): an `instructions.slack.md` variant next to
`instructions.md`, plus mechanics in `agent.ts`:

```ts
// agent/agent.ts
export default {
  name: "support",
  surfaces: {
    slack: { mode: "append" },               // or "replace": the variant is the whole system prompt
    crisp: { denyTools: ["gdrive__delete_file"] }, // unlisted AND undispatchable on this surface
  },
};
```

A `mode` without a matching `instructions.<source>.md` throws. The old
`channels/<source>.md` overlay still loads, with a deprecation warning. See
[the agent directory](/docs/agents-directory).

## Why it matters

A channel is the only code that touches the platform, and it does the parts
that are easy to get wrong for you: signature and replay checks, fast ACKs,
retry dedup, and identity decided from verified evidence rather than payload
claims. Everything past the webhook is one agent, one tool registry, and one
`ctx.user` check, whichever platform the turn came from.
