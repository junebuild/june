---
"@junejs/server": minor
---

Add the Durable Object edge target + selectable agent-runtime backends.

- `@junejs/server/agent-durable` — the first-class edge seam. `DoSessionStore`
  runs over a Durable Object's synchronous `ctx.storage.sql` +
  `transactionSync`, so the exact durability contract (exactly-once) holds on the
  edge. One DO = one session, so the store needs no `session_id`. `AgentDurableObject`
  runs a durable turn inside a DO (POST /turn, GET /transcript); `durableFetch`
  routes a request to a session's DO by `idFromName`. Follows the no-external-
  types discipline — the Cloudflare surface is minimal structural interfaces and
  there is NO `cloudflare:workers` import, so it typechecks + unit-tests under Bun
  against a fake `SqlStorage`. The app supplies the 4-line `extends DurableObject`
  shell in its worker.
- The Durable Object is **optional**. `createAgentRuntime(agents, { backend })`
  selects the in-process backend — `native` (SQLite, durable on a long-running
  host; the default no-DO answer) or `memory` (ephemeral, no disk — dev/tests/
  stateless previews via the new `MemoryRuntime`). `durable` is the DO target the
  worker constructs (createAgentRuntime throws with guidance rather than pretend).
