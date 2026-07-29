---
"@junejs/core": patch
---

ModelFinish — adapters report WHY generation stopped; the engine fails abnormal-empty turns loudly.

Every provider ships a why-it-stopped field (the Messages API's `stop_reason`, Gemini's
`candidates[].finishReason`) and documents that an abnormal stop — token limit, content
filter, malformed tool call — may carry NO content. An adapter that ignores the field
converts such a stop into a graceful empty reply, which the engine then "completes"
silently: the turn ends with `""`, a channel renders nothing, and nobody is told why.

- `ModelDelta`'s `done` gains an optional `finish?: ModelFinish` — `{ reason: "stop" |
  "max_tokens" | "content_filter" | "malformed_tool_call" | "refusal" | "other", raw?
  }`, with the provider's own enum value preserved in `raw`. `replyStream` accepts it as
  an optional second argument.
- The engine fails the model step when the finish is abnormal AND the reply is empty
  (no text, no tool calls) — thrown before the checkpoint, so it retries like any model
  failure and surfaces via `turn.failed` / `onTurnError`. A reply WITH content under an
  abnormal reason still commits (truncated-but-usable), and adapters that report no
  finish keep today's behavior — deliberate empty completions (tool-only turns) stay
  legitimate.
- `anthropic()` now reads `finalMessage().stop_reason` (typed on @anthropic-ai/sdk
  ≥0.60's Message) and maps it via the exported `finishFromStopReason`: end_turn /
  stop_sequence / tool_use → stop; max_tokens / model_context_window_exceeded →
  max_tokens; refusal → refusal; anything else → other.
