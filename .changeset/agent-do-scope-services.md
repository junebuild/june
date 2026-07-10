---
"@junejs/db": minor
"@junejs/server": minor
---

Make the Durable Object a first-class scope root, so tools reach ambient `db` and
app-defined services WITHOUT a module-global setter or `env` on ctx.

A DO is a separate isolate from the Worker entry, reached by RPC — so the
pipeline's request scope (and its ambient `db`/`kv`/`blob`) never crossed into it.
That left tools running in a DO with only `ToolContext` and no way to reach
resources June doesn't model (Vectorize, Workers AI, an app ledger, a signing
secret), forcing apps to a per-isolate module-global setter that is null if
injected in the wrong isolate.

Now:
- `@junejs/db` — `RequestScope` gains an app-defined `services?: unknown` bag
  (opaque here; the app types it at the read), seeded by the host at each isolate
  entry from that isolate's env. New `currentServices<T>()` reads it (soft —
  returns `undefined` outside a scope / when unseeded, so the app's own typed
  accessor decides whether a missing service throws). Re-exported from
  `@junejs/server`.
- `@junejs/server/agent-durable` — `DoAgentDef` gains `resources?` and `services?`.
  The app builds them from the DO's own env in the DO constructor (where env
  lives), and `AgentDurableObject` runs every turn inside `runInScope(...)` seeded
  with them. So a tool reads ambient `db` (from `resources`) and `currentServices()`
  exactly as a route loader does. `locals` is fresh per turn — a fresh scope per
  turn means per-turn state (e.g. Juno's batch-loader registry) can't leak across
  turns on a long-lived DO. Additive: a def without `resources`/`services` runs in
  an empty scope, unchanged.

This also fixes a latent gap: ambient `db` was previously unavailable (it threw)
inside a DO tool, since no scope was ever entered there.
