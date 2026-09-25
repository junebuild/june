---
"@junejs/server": patch
"@junejs/core": patch
---

The native `mountAgent` now provides `ctx.runStream` and `ctx.resumeStream` (#169). Before, its `ChannelContext` had only `run`/`runDetached`/`resetSession`, so `slackChannel({ stream: true })` silently fell back to one `chat.postMessage` at the end of the turn, Approve/Deny clicks on a parked turn hit "the host provides no resumeStream", and `receive()` refused proactive delivery — all of which work on the edge Durable Object. Both seams run over the in-process session (`start()`/`resume()` plus an eager per-turn subscription, the same iterator the DO's delivered renders use, now shared from `turn-events.ts`), so a channel behaves the same on both hosts. With `stream` off, Slack replies on the native host now go through the HITL-aware post-once render as they do on the edge.

Also fixed in core: every turn that ends in a rejection now announces a terminal event. A live consumer (this runStream, and the edge Durable Object's SSE stream alike) ends on turn.completed / failed / cancelled or input.requested, and some rejections emitted none, so it hung forever: a turn refused on the session chain because an earlier queued turn had parked meanwhile, and a store error while opening a turn or while recording its cancellation or park. `AgentSession` now emits `turn.failed` for any rejected turn that has not already announced its end; a turn that did is left alone, and `result()` is unchanged.
