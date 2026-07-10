---
"@junejs/core": patch
---

Channel extension seams: `onEvent` (observe/mirror), `mode`, and `accept` on slackChannel + crispChannel.

An app can now sit on the built-in channel instead of forking its webhook — inheriting all the signature/replay/malformed/blank hardening:

- `onEvent({ raw, event })` — a background mirror hook called for EVERY signature-verified event, before the turn's loop guard (so operator/bot/non-text events are visible too). For ingesting a conversation into an app store (e.g. a RAG source of truth).
- `mode: "observe"` — shadow mode: never run a turn or post a reply; only `onEvent` fires. `mode: "respond"` (default) keeps replying and still fires `onEvent`.
- `accept(raw)` — gate a verified event before any work (returns false → ACK 200, ignore); a website/channel allowlist lives here.
