---
"@junejs/core": minor
"@junejs/server": minor
---

Add the durable agent-runtime foundation.

- `@junejs/core/agent-runtime` — a pure (zero `node:*`) durable turn engine and
  its seams: `SessionStore` / `Broadcaster` / `Model`, the `AgentSession` actor
  (turn serialization), and `Runtime`. Durability is log-replay + step-checkpoint
  with session-scoped checkpoint keys; exactly-once for local tool side effects,
  at-least-once for remote/subagent tools. Sibling to `@junejs/core/agent` (the
  `defineAction` registry it consumes), not a replacement.
- `@junejs/server/agent-native` — the native seam: `NativeRuntime` /
  `createNativeRuntime` over a synchronous SQLite handle (a new
  `openLocalSqliteSync` export from the sqlite driver — the durability
  transaction must be synchronous, so it uses the raw handle rather than the
  async `JuneDb`).
