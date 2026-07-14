---
"@junejs/core": patch
---

Harden Slack native streaming against the chat.startStream contract + the agent-era status line.

- `chat.appendStream` errors are no longer ignored: `stopped_by_user` (the human hit Stop) ends rendering; `ratelimited` retries once honoring Retry-After; anything else surfaces via `onError` and the unsent tail posts via `chat.postMessage` — no silent truncation.
- Token deltas now coalesce (~2 flushes/s, sliced at Slack's 12k markdown cap) so a long turn can't spend appendStream's Tier-4 budget; the first token still seeds the stream immediately.
- `DeliveryTarget` grows `recipientUserId`/`recipientTeamId` — chat.startStream requires them to open a TOP-LEVEL channel stream (no `thread_ts`), which proactive delivery can now do natively.
- `slackChannel({ status: "is thinking…" })` shows the assistant thread status while a turn runs (`assistant.threads.setStatus`, best-effort); Slack clears it when the reply posts, and a tool-only turn clears it explicitly.
- Opt-in live contract suite: `SLACK_LIVE_BOT_TOKEN` + `SLACK_LIVE_CHANNEL` run `test/slack-live.test.ts` against the real api.slack.com.
