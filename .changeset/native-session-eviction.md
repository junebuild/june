---
"@junejs/server": patch
"@junejs/core": patch
---

`NativeRuntime` no longer keeps every session actor forever (#174). It memoized one `AgentSession` per `agent:id` in a Map that was never pruned, and with `slackChannel` every thread is a session, so a long-running host grew by one actor per thread for its whole life. The memo is now an LRU with a soft cap, `createNativeRuntime(agents, path, { maxSessions })` (default 1000; also `createAgentRuntime(agents, { maxSessions })`): past it, the least recently used idle actors are dropped and rebuilt from SQLite on their next use. An actor is only dropped when `AgentSession.idle()` (new) is true — no turn running or queued, no reset pending — and nothing is subscribed to its events, so busy sessions can take the count past the cap. Call `runtime.session()` at the point of use rather than holding an `AgentSession` across awaits. The memory backend is unchanged: its actors are its state, so it cannot evict.
