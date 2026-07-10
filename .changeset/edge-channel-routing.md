---
"@junejs/core": patch
"@junejs/server": patch
---

Edge channel routing: mount an agent's inbound channels (Slack/Crisp webhooks, http)
on the Worker entry and route each turn into the per-session Durable Object — no
hand-rolled webhook and no module-global signing-secret setter.

A Durable Object never sees the Worker's `env` at module scope, and on workerd a
signing secret exists ONLY in `env` inside an invocation — so a channel that needs a
secret can't be fully built where it's declared. Until now June's generated worker
mounted only the chat endpoint, so an edge app hand-rolled the webhook (verify →
`durableFetch`) and reached for a per-isolate module-global to smuggle the secret in.

Now:
- `@junejs/core/agent-config` — a channel module may default-export a `Channel` OR a
  `ChannelFactory = (env) => Channel`. `resolveChannel(c, env)` resolves either;
  `channelDispatch(channels, ctx)` is the dispatch core (`channelFetch` delegates to
  it) so an edge surface can drive it with channels resolved from env. `ChannelContext`
  gains `waitUntil?` — the host passes workerd's `ctx.waitUntil` so a webhook's fast-ACK
  background work (run the turn, post the reply) survives the response instead of being
  killed when the isolate is reclaimed. `crispChannel`/`slackChannel` use it when present
  (native has none and keeps the floating-promise behavior — additive, backward compatible).
- `@junejs/server/agent-durable` — new `durableChannelSurface(getNamespace, { agentName,
  channels, env, waitUntil? })`: resolves factory channels from the worker env (secrets
  bind here), verifies the signature, derives the session, and routes the turn into the
  session DO via `durableFetch`, posting the reply back out on `waitUntil`. The sibling of
  `durableAgentSurface`; a worker composes both.
- `@junejs/server` discovery resolves a `(env) => Channel` factory with `process.env`, so
  the Shape-B factory form works on native too; a plain `Channel` default export is
  unchanged.

The `examples/agent-edge` worker now shows a Shape-B crisp channel wired via
`durableChannelSurface`. Build codegen that generates the whole edge agent entry
(DO shell + surfaces) remains a separate, later milestone.
