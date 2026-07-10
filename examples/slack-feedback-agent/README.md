# slack-feedback-agent — per-kind hooks + hook-level services

A Slack agent on Cloudflare (Workers + Durable Objects) that demonstrates the round-2
channel hooks, where the channel is a **routing table** and all domain logic lives in a
service:

- **`@mention` → a Q&A turn** (`respondTo: ["app_mention"]`) — the model answers, with the
  Slack read tools (`slack_read_thread`, `slack_list_reactions`, …) available.
- **emoji reaction → a deterministic write** (`on: { reaction_added, reaction_removed }`) —
  recorded via `ctx.services.feedback.record(event)`. **No LLM turn, no reply.**

One `makeServices(env)` factory feeds **both** the DO turn and the edge hooks — the same DI
bag `currentServices()` would give a turn, reachable from a channel hook that runs at the
edge (outside the DO).

```ts
slackChannel({
  respondTo: ["app_mention"],                          // mention → turn + reply
  botUserId: env.SLACK_BOT_USER_ID,
  on: {                                                // reaction → deterministic, no LLM
    reaction_added:   (e, ctx) => (ctx.services as Services).feedback.record(e),
    reaction_removed: (e, ctx) => (ctx.services as Services).feedback.record(e),
  },
})
// events derived from respondTo + on keys → app_mention, reaction_added, reaction_removed
```

Things this example shows, from the dev.1→dev.4 channel work:

| | |
|---|---|
| `respondTo` | per-kind turn control — mention responds, reaction doesn't |
| `on[kind]` | typed, non-optional event, no `event.kind` demux or `event?` guard |
| derived `events` | subscribe list inferred from `respondTo` + `on` keys (no drift) |
| `ctx.services` | hook-level DI — resolved once, wired into `durableChannelSurface` |
| `channels` + `env` | the DO builds the channel's capability tools in-isolate |
| `channelInstructions` | a Slack-source system overlay for the mention turn |

## Run it locally (no secrets)

```bash
bun install
bun run dev          # → http://localhost:8787

curl -sX POST localhost:8787/message -d '{"message":"hi","session":"s1"}'
# → {"text":"(offline) You said: hi"}
```

Offline uses a scripted model; the `on` hooks and `ctx.services` are real either way.

## Live: reactions become feedback

Wire a Slack app (see `slack-agent`'s README for scopes + Event Subscriptions; also
subscribe to `reaction_added` / `reaction_removed`). Point the Request URL at
`.../channels/slack`, set the secrets (`.dev.vars.example`), and deploy.

- `@mention` the bot → it answers in-thread.
- Add an emoji to any message → the edge hook records it (no LLM).
- `GET /feedback` → the reactions recorded by the hook.

> The example's `feedback` store is in-memory (per-isolate) to stay self-contained. In
> production `record` writes to D1/KV so the edge hook and the DO turn share state — the
> point is the wiring: one services factory, reachable from both.

Crisp parity: `crispChannel` has the same `on.message` + `onEvent` firehose + `mode:"observe"`,
so a Crisp shadow-mirror uses the identical shape.
