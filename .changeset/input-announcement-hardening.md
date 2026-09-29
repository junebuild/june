---
"@junejs/core": patch
"@junejs/server": patch
---

Input announcements (#260): close five delivery gaps.

- **A reset can no longer lose announcements.** It archived the session and re-recorded the
  undelivered announcements (plus the `retired` one) in two transactions; a crash between them
  lost them. `SessionStore.reset(inTx?)` now runs a callback inside its transaction, after the
  archive, and the engine carries the announcements that way. The Durable Object, native
  SQLite and memory stores implement it. `RUNTIME_API_VERSION` is 5 (server and core in
  lockstep): a store that ignored the callback would drop them silently.
- **A failed hook is retried without waiting for the session's next activity**, 5 s doubling
  to 5 min: on the Durable Object's alarm, on a timer in the native and memory runtimes.
- **Durable Object watchdog.** An alarm a minute out is armed before anything can record an
  announcement — a turn starting, a resume, a reset, a held inbound turn — so an object that
  dies between recording one and delivering it still delivers, with no further request. New
  `AgentDurableObject.alarm()`; `june build`'s shell forwards it, and a custom shell must.
- **Native startup scan.** `createNativeRuntime` delivers every session's leftovers at
  startup instead of when each session is next used (reading the agent and session from the
  announcement, so agent names may contain `:`).
- **No double delivery across eviction.** `AgentSession.idle()` is false while a flush is in
  flight, so the native runtime cannot evict an actor mid-delivery and rebuild it to hand the
  same announcement over again. A flush with nothing to deliver no longer counts as in flight.
