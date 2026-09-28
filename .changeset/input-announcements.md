---
"@junejs/core": minor
"@junejs/server": patch
---

Input announcements: hosts hear about every parked input, across sessions (#260).

A parked `requestInput` lived only in its session's store, and `input.requested` reached only a
live subscriber of that turn — nothing could list what waits on a person across sessions, or
learn that a request was answered elsewhere.

- `InputAnnouncement`, delivered to the new `onInputAnnouncement` hook (agent.ts config,
  `defineAgent`, the native `AgentDef` via `toAgentDef`, `DoAgentDef`):
  - `parked` — the request, the triggering event (raw stripped), the held count;
  - `held` — an inbound turn was held behind the park (#263), with the new count;
  - `resolved` — `"answered"` by `by`, or `"retired"` by a session reset.
- **Durable, at-least-once, in order.** Each announcement is recorded in the same transaction
  as the state change it reports, in an outbox in the session's store, and removed only after
  the hook returns. A hook that throws keeps it for the next flush; a session rebuilt after a
  crash (or in a new life of a Durable Object) delivers what the earlier one left. Every
  announcement has a unique `id` — dedupe on it. Nothing is recorded while no hook is set.
- On the Durable Object the hook runs in the request scope (ambient db / services), so it can
  write a cross-session `pending_actions` index directly.
- `input.resolved` TurnEvent for live subscribers of the parked turn;
  `session.flushAnnouncements()` and `session.undeliveredAnnouncements()`.
- Runtime API v4 (`@junejs/server` checks it at power-on).
