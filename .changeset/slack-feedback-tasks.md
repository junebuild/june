---
"@junejs/core": patch
---

Slack agent-era surfaces: native feedback buttons + tool-call task timeline.

- `slackChannel({ feedback: true })` — the streamed reply finalizes with Slack's native 👍/👎 (`chat.stopStream` carries a `context_actions` block with `feedback_buttons`); clicks arrive normalized in `onFeedback` as `SlackFeedback` ({rating, turnId, session, user, channelId, threadId, messageTs}) — pure telemetry, background + best-effort.
- `slackChannel({ tasks: (call) => title })` — tool calls render as Slack's native task timeline inside the streamed message (`task_update` chunks: in_progress on action.requested, complete on action.completed; `taskDisplayMode` picks timeline/plan/dense). Opt-in because it deliberately departs from lazy-start: a tool-only turn now posts the timeline. Chunk failures are decorative loss (reported, never truncating text); the postMessage fallback stays text-only.
- Two live-verified contract fixes: channel streams carry `recipient_user_id`/`recipient_team_id` even in-thread (`missing_recipient_team_id` otherwise — inbound events now thread the envelope's `team_id` through `InboundEvent.teamId` and stream to the asker), and a task-enabled stream runs entirely in chunks mode (`streaming_mode_mismatch` forbids mixing raw `markdown_text` into a chunks-opened stream).
- Live contract suite grows preflight diagnostics and a chunks + feedback-blocks case.
