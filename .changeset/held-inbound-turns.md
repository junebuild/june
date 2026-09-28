---
"@junejs/core": minor
"@junejs/server": patch
---

Hold inbound turns while a session is parked on `requestInput`, instead of rejecting them (#263).

A turn started against a parked session was always rejected ("session is suspended awaiting
input …", a 409 on the Durable Object). That stays the default — right on an interactive
surface — but a channel whose other party keeps talking regardless (email: a follow-up arrives
while the draft awaits approval) can now ask for the turn to be held:

- `TurnInput.ifSuspended: "reject" | "queue"`. With `"queue"`, `start()` holds the turn in the
  session's own store — durable across a restart, idempotent per `turnId`, `event.raw`
  stripped — and returns `{ turnId, queued: true }`. Held turns run one at a time, oldest
  first, once the park resolves; one that parks again holds the rest behind it.
- `hostContext` rides with a held turn and comes back through `session.onDequeue`, called as
  the turn starts. `session.drain()` (for a host rebuilding a session), `session.heldTurns()`,
  and `pending().queued` — the approver's cue that the conversation moved on — are new.
- Durable Object: `/turn` takes `ifSuspended`; `"queue"` needs `deliver=1` or `detach=1`
  (a streaming caller asking to be held is a 400). A held delivered turn's reply is rendered
  through its source channel when it runs, in whichever life of the object that is.
  `runDetached` / `runDelivered` accept `ifSuspended` and return `queued`.

The native host does not take `ifSuspended` yet (it has no delivered mode to render a held
turn's reply).
