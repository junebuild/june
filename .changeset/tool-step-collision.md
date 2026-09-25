---
"@junejs/core": patch
---

Fix a turn loop that spun forever, synchronously, when a tool call reused an id an earlier call in the same session had used (#167). Tool steps were checkpointed under `tool:<callId>`, but a provider call id is only unique within one reply (some providers mint `call_0` on every reply; the mock behind the report restarted at `toolu_1`). The later call found the earlier step "cached", skipped the tool without answering it, and the loop re-read the unchanged transcript without ever yielding — pinning the host at 100% CPU with its event loop blocked, so every other session on the process froze with it. Under a burst of Slack mentions on the native host this presented as a concurrency livelock; it was not one.

Tool steps are now keyed `tool:<n>:<callId>`, where `n` is the transcript index of the assistant message that made the call (the same `n` as its `model:<n>` step), and the engine decides which calls are still owed a result from the transcript rather than the step cache. That also fixes a replay that crashed mid-batch: it used to skip the batch's remaining calls and ask the model with a `tool_use` left unanswered (a provider 400); it now runs them first. `turn.failed`'s `step` and crash-injection step ids use the new form. A turn persisted by an older version replays correctly: calls it already answered are recognized by their tool messages.
