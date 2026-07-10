---
"@junejs/core": patch
"@junejs/server": patch
---

The turn as a live process — P1 (see docs/rfc-turn-as-live-process.md). A turn is no longer only `Promise<string>`; it emits a durable, observable stream of typed events.

- **TurnEvent bus**: `runTurn` emits structured events (`turn.started`, `action.requested`/`completed`, `message.completed`, `turn.completed`/`failed`) at its step boundaries; `Broadcaster.publish(turnId)` is now `EventSink.emit(TurnEvent)`.
- **`start` / `result` / `observe`**: `AgentSession.start(input) => { turnId }` (non-blocking) + `result(turnId) => Promise<TurnResult>` (completed | failed); `observe(cb, { turnId?, replay? })` folds the structural prefix from the durable log for a late/reconnecting subscriber, then goes live. `turn() => Promise<string>` stays as the non-interactive convenience.
- **SSE transport**: the Durable Object `/turn` streams TurnEvents as `text/event-stream` (with `no-store` + a `:hb` heartbeat); `durableAgentSurface` pipes it through on `Accept: text/event-stream` (live chat) or collapses to `{ text }`.
- **Channel render**: `ChannelContext.runStream` exposes the live TurnEvent stream; `slackChannel({ stream: true })` posts "Thinking…" then edits that one message in place (tool status → final answer). Exported primitives: `sseTurnEvents`, `sseTurnFinalText`.

Token-level streaming into the same message (`reasoning.delta`/`message.delta`), suspend/resume (HITL), and proactive turns are the following phases (P2–P4).
