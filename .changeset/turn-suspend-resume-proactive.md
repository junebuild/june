---
"@junejs/core": patch
"@junejs/server": patch
---

Suspend/resume (HITL) + proactive turns — RFC P3, P3b, P4 (see docs/rfc-turn-as-live-process.md). The turn-as-live-process RFC is now fully shipped.

- **P3 — suspend / resume (HITL)**: a tool pauses a turn for human input with `ctx.requestInput({ id, prompt, answererId? })`; the turn parks durably as a consumable `suspended` checkpoint (the DO can hibernate) and emits `input.requested`. `AgentSession.resume(turnId, inputId, input, { by })` validates the target + inputId and enforces the answerer (default-deny when `answererId` is set), then replays the same durable step-checkpoint machine — exactly-once, now "a step whose result comes from a human". The DO gains a streamed `POST /resume`; `/turn` and `/resume` map suspension conflicts to 4xx (403 unauthorized answerer, 409 wrong/parked turn) instead of crashing.
- **P3b — Slack HITL**: `input.requested` renders Approve/Deny Block Kit buttons (`june_input:*`); a signed `block_actions` interaction routes to `resume` with the clicker's verified id. A rejected click (wrong/stale answerer) leaves the buttons intact and tells only the clicker (ephemeral); HITL works in both stream and post-once render modes; dead ends (unusable payload, no resumeStream) surface via `onError`.
- **P4 — proactive / agent-initiated**: a distinct `trigger`-role `Msg` opens a proactive turn attributed to `by` (a schedule, another channel, the agent), mapped to a user message at the model adapter (no new provider role). `channel.deliver(target, events)` renders a turn's stream to a `DeliveryTarget` with no inbound event; `receive(channel, ctx, { seed, target, trigger, session })` starts the proactive turn and wires its stream to `deliver`. The trigger threads through the edge (`serializeTurn` → DO `/turn` → `session.start`).
