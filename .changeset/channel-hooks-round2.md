---
"@junejs/core": patch
"@junejs/server": patch
---

Channel hooks round 2 — less transport glue in a thin wrapper:

- **`on` (per-kind observers)**: `slackChannel({ on: { reaction_added: (event, ctx) => … } })` — a typed handler that fires only for its kind, only when a normalized event exists (post bot/loop guards), so `event` is non-optional and there's no `event.kind` demux or `event?` guard. Coexists with `onEvent` (the raw firehose). `crispChannel` gets `on.message`.
- **`ctx.services` (hook-level DI)**: channel hooks run at the edge, outside the Durable Object, so they can't read the DO's `currentServices()`. `durableChannelSurface({ services: (env) => makeServices(env) })` (and `mountAgent({ services })`) resolve the SAME factory and expose it as `ctx.services` — one DI story for edge and turn; a hook writes via `ctx.services.feedback.record(…)` instead of re-plumbing bindings.
- **Derived `events`**: when omitted, the Slack subscribe list is derived from `respondTo` + `on` keys (union) so kinds aren't written twice and can't drift; pass `events` explicitly to override. The friendly default (message + app_mention) still applies when no intent is expressed.
