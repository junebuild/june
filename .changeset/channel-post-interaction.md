---
"@junejs/core": patch
---

Channel outbound + interaction completeness (#88, #89, and the observability half of #90):

- `channel.post(target, content)` (#89) — deterministic outbound post (no LLM, no stream) over the channel's own auth/transport, returning the sent message's identity (`{ channelId, threadId?, ts }`; `ts` is Slack's message ts / Crisp's fingerprint). Unlike the best-effort reply path it throws loudly on a platform error. Implemented on both `slackChannel` and `crispChannel`.
- `slackChannel({ onInteraction })` (#88) — every signature-verified interaction payload the built-in routing does not claim (`june_feedback` / `june_input:*`) is handed to the app instead of silently dropped, so an app's own buttons ride the same endpoint (no parallel webhook, no duplicated signature verification).
- `feedbackBlocks(turnId?, session?)` is now exported (#88) — a message the app posts itself (via `channel.post`) can carry the same native 👍/👎 the streamed reply gets, and clicks route through the same `onFeedback`.
- `onRejected(rejection, req)` on both channels (#90) — names the silent turn-away paths (`bad_signature`, `malformed_body`, `unrouted_interaction`). Observability only; never changes the response, and a throwing hook is contained.
