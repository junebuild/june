---
"@junejs/core": patch
---

Streaming-first Model + native Slack token streaming (RFC P2, see docs/rfc-turn-as-live-process.md).

- `Model` is now `(msgs, tools, opts?) => AsyncIterable<ModelDelta>` where `ModelDelta = reasoning | text | done`; a one-shot reply is the degenerate case. `replyStream(reply)` builds it for non-streaming models.
- The anthropic adapter unfolds the SDK message stream into `text`/`thinking` deltas, then `finalMessage()` as the authoritative `done.reply`. `modelStep` emits `reasoning.delta`/`message.delta` as live TurnEvents and checkpoints `done.reply` (treating `done` as terminal).
- `slackChannel({ stream: true })` streams tokens into ONE message via Slack's native `chat.startStream` → `appendStream` → `stopStream` (seeded with the first token), lazily — a tool-only/empty turn posts nothing; failures are always surfaced; falls back to `chat.postMessage` when `startStream` is unavailable.
