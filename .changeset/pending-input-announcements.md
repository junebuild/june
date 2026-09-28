---
"@junejs/core": minor
"@junejs/server": patch
---

Announce parks and resolutions so pending inputs can be indexed across sessions (#260).

A park lived only in its own session's store and reached only a live subscriber of that turn,
so nothing could answer "what is waiting on a person right now?" across sessions, and nobody
learned when a request was answered elsewhere.

- `onPendingInput(change)` on the agent (`agent.ts`, `defineAgent`, `DoAgentDef`, the native
  `AgentDef` via `toAgentDef`) is told of every park (`kind: "requested"` — session, turn and
  input ids, prompt, schema, answerers, the triggering event with `raw` stripped) and every
  resolution (`kind: "resolved"`, `outcome: "answered"` with `by`, or `"cancelled"` by a
  reset). `PendingInputChange` / `PendingInputHook` are exported.
- Delivery is at least once and in order per session, through an outbox: each change is
  written in the same transaction as the park, the answer or the reset, kept outside the
  steps (a reset never archives it), and deleted only after the hook returns. `change.id`
  (`agent/session/turnId/inputId/kind`, each part percent-encoded) is stable and unique
  across agents and sessions, for deduping. `session.deliverPendingInputChanges(hook)` is the
  primitive; `session.idle()` is false while a delivery is in flight.
- A new live `TurnEvent`, `input.resolved`, is emitted after an answer or a reset commits and
  before any continuation starts.
- `SessionStore` gains optional `outboxPut` / `outboxList` / `outboxDel`, and `reset(inTx?)`
  runs a callback inside its transaction. The Durable Object, native SQLite, and memory
  stores implement them; a store without them still parks and resumes, and only delivery
  fails, loudly.
- `RUNTIME_API_VERSION` is 4 (server and core bumped in lockstep): a server with an older core
  fails at power-on instead of silently missing the outbox.
- Durable Object: the hook runs in the request scope; a failure retries on the object's alarm
  (5 s doubling to 5 min); a one-minute watchdog alarm is armed before anything can commit an
  announcement (when a turn starts, before an answer or a reset); a rebuilt session delivers
  leftovers. New `AgentDurableObject.alarm()`; `june build`'s shell forwards
  it, and a custom shell must too.
- Native: the runtime delivers after every change and on every session (re)build, retries on
  an unref'd timer, and `createNativeRuntime` delivers every session's leftovers at startup
  (reading the agent and session from the change, so agent names may contain `:`). The
  delivery listener does not count as a subscriber, so it never blocks eviction of an idle
  session — and a session with a delivery in flight is not idle.
