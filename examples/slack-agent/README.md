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

## What's next (not in this example yet)

- **Block Kit / rich output** and updating a posted message.
- **Crisp parity** — `crispChannel` has the symmetric envelope +
  `crisp_read_conversation`; a Crisp example could mirror this one.
