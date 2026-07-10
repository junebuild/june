# slack-agent — a Slack assistant that reads threads & reactions

A deployable example of June's durable agent on the **edge**, wired to Slack. It
demonstrates the two sides of a single `slackChannel(...)`:

- **Inbound** — the signed Events API webhook (mounted on the Worker) routes each
  message to a per-session Durable Object (one DO = one Slack thread).
- **Outbound capabilities** — the channel's **capability tools**, handed to the
  agent so it can act on the workspace:
  - `slack_read_thread` — read a thread's replies (author id, text, ts)
  - `slack_list_reactions` — who reacted with which emoji (name, count, user ids)
  - `slack_resolve_user` — resolve a user id to a name / display name
  - `slack_add_reaction` — react back on a message with an emoji

Each tool **defaults its target from the current turn** (the thread/message/user
that triggered it), so the model can call `slack_read_thread` with no arguments and
get the thread it's already in.

## Run it locally (no secrets needed)

```bash
bun install
bun run dev          # bunx wrangler dev → http://localhost:8787

curl -sX POST localhost:8787/message -d '{"message":"hello","session":"s1"}'
# → {"text":"(offline) You said: hello. ..."}
```

Offline by design: with no `ANTHROPIC_API_KEY` the agent runs a deterministic
scripted model, so the durable loop + DO storage work with zero secrets. The Slack
tools only do something real once a bot token is present.

## Wire it to a real Slack workspace

1. **Create a Slack app** (api.slack.com/apps → From scratch), install it to your
   workspace, and `/invite @your-bot` into a channel.
2. **Bot Token Scopes** (OAuth & Permissions): `channels:history`, `groups:history`,
   `reactions:read`, `users:read`, `chat:write`, `app_mentions:read`. Reinstall the
   app after changing scopes.
3. **Secrets** — copy `.dev.vars.example` → `.dev.vars` (git-ignored) for dev, or
   `wrangler secret put SLACK_BOT_TOKEN` (and `SLACK_SIGNING_SECRET`,
   `ANTHROPIC_API_KEY`) for deploy. Use the **Bot User OAuth Token** (`xoxb-…`), not
   a user token (`xoxp-…`).
4. **Event Subscriptions** → Request URL: `https://<your-worker>/channels/slack`
   (Slack sends a `url_verification` challenge; the channel echoes it). Subscribe to
   bot events: `message.channels` (public), `message.im` (DMs), `app_mention`, and —
   if you enable reaction turns — `reaction_added` / `reaction_removed`.
5. `bun run deploy`. Post in the channel — the bot replies in-thread, and when you
   ask "who reacted?" / "summarize this thread" it reads the replies and reactions.

## Event triggers

`message` and `app_mention` become turns by default. To have the agent react in real
time when someone adds an emoji, opt in on the channel:

```ts
slackChannel({ ..., events: ["message", "app_mention", "reaction_added"], botUserId: "U…" })
```

A reaction turn carries the emoji + target message on `event.reaction`; the agent can
answer, or react back with `slack_add_reaction`. `botUserId` stops the bot's own
reactions from looping into a turn.

## Observe / shadow mode (mirror without replying)

Both channels take three extension hooks so you can sit on the built-in instead of
forking its webhook — inheriting the signature / replay / malformed-body / blank-input
hardening for free:

```ts
crispChannel({
  signingSecret, identifier, key,
  mode: "observe",                                   // shadow: never run a turn or reply
  accept: (raw) => raw?.data?.website_id === MINE,    // gate before any work (allowlist)
  onEvent: ({ raw, event }) => mirrorToStore(raw),    // fires for EVERY verified event
})                                                    // (visitor + operator + non-text)
```

- `onEvent` — mirror hook, runs in the background for every signature-verified event
  (before the turn's loop guard, so operator/non-text events are visible too). Ideal for
  ingesting a conversation into a RAG source of truth.
- `mode: "observe"` — pure ingestion: no turn, no reply, zero LLM cost.
- `accept` — reject an event (returns `false` → ACK 200, ignore).

`mode: "respond"` (default) keeps the reply behavior AND still fires `onEvent` if set —
so you can mirror and answer at the same time.

### Per-kind `respondTo` — mention runs a turn, reaction just observes

`mode` is channel-wide; `respondTo` is per event kind. Subscribe to several kinds but
only let some drive a turn:

```ts
slackChannel({
  events: ["app_mention", "reaction_added"],
  respondTo: ["app_mention"],       // mention → turn+reply; reaction → onEvent only (no LLM)
  botUserId: "U…",
  onEvent: ({ event }) => recordReaction(event),
})
```

### Channel tools on the edge, and source-aware instructions

- `AgentDurableObject({ channels: [makeSlack], env })` builds the channel's capability
  tools inside the DO — the edge equivalent of `defineAgent` merging them on native.
- `channelInstructions: { slack: "…" }` appends a system overlay when the turn's real
  `event.source` matches — a shared agent branches on the unforgeable source, not a
  userText marker.
- Building a fully custom channel? The signing/normalization primitives are exported —
  `verifySlackSignature`, `verifyCrispSignature`, `normalizeSlackEvent`, `tryParseJson`,
  `timestampFresh` — so a fork is ~30 lines of domain logic, no re-implemented crypto.

## What's next (not in this example yet)

- **Block Kit / rich output** and updating a posted message.
