# @junejs/core

## 0.1.1-dev.0

### Patch Changes

- Channel capabilities: agents can now read and act on chat platforms, not just echo text.

  - `InboundEvent` normalized envelope threaded into turn + tool context (`ToolContext.event`), carried end-to-end over the durable `/turn` RPC and the native path.
  - Channels can contribute outbound capability tools (`Channel.tools`), merged into `agent.tools` by `defineAgent` (which now throws on a duplicate tool name).
  - Slack: `slack_read_thread`, `slack_list_reactions`, `slack_resolve_user`, `slack_add_reaction`; `message` / `app_mention` / `reaction_added` / `reaction_removed` event turns (reactions opt-in via `events`, `botUserId` loop guard).
  - Crisp: normalized envelope + `crisp_read_conversation`; empty replies no longer posted.
  - Cross-channel safety: tools default their target from the current event only when `event.source` matches. Durable `/turn` serialization drops an unserializable `event.raw` instead of failing the turn.

## 0.1.0

### Minor Changes

- [`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f) Thanks [@linyiru](https://github.com/linyiru)! - Auto-mount the durable agent from `june.config` (build order step 4).

  - `@junejs/core/config`: an `agent.runtime` block (`enabled` / `dir` / `backend` /
    `chat.path` / `channels`), resolved by `resolveAgent`. `channelFetch` now
    returns `Response | null` so it composes as a fall-through surface.
  - `@junejs/server`: the shared render pipeline gains an `agentSurface` slot (runs
    after the static agent surface `/mcp` + discovery, before middleware/routes).
    `mountAgent` gains `surface` — a framework chat endpoint at `chat.path` (POST
    `{message, session?}` → a durable turn) plus the discovered channels. The dev
    server auto-discovers an `agent/` directory and mounts it with an Anthropic
    model: drop an `agent/` folder and `POST /message`, `/channels/*`, and `/mcp`
    (its tools) are all live — no glue.

  Edge (worker.ts + Durable Object routing) is a follow-up; dev auto-mount ships now.

- [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3) Thanks [@linyiru](https://github.com/linyiru)! - Add agent channels — inbound edges (http / slack / crisp).

  - `@junejs/core/agent-config` — the `Channel` / `ChannelContext` contract,
    `defineChannel`, and `channelFetch` (a pure Web-standard router that dispatches
    webhook channels by path and http channels by fall-through). `AgentDefinition`
    now carries `channels`.
  - `@junejs/core/channels` — built-in channel factories: `httpChannel` (POST
    /message + optional /mcp), `slackChannel`, `crispChannel`. Web-standard
    (`crypto.subtle` HMAC verification, `fetch` reply-out — zero `node:*`, edge-
    ready). Secrets are injected as options, so the channel stays portable across
    native and edge; loop guards (bot/operator self-messages) prevent reply loops.
  - `@junejs/server` — `discoverAgent` now scans `channels/*.ts`; new `mountAgent`
    builds a `ChannelContext` whose `run` bridges to a durable turn and returns a
    fetch handler (webhooks + http) plus `startAll` for one-shot channels (cli).

- [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d) Thanks [@linyiru](https://github.com/linyiru)! - Add agent connections — outbound tool sources (the mirror of channels).

  - `@junejs/core/connections` — `defineMcpConnection` / `defineOpenapiConnection`
    and `connectAll`: wire an agent into an external MCP server or an OpenAPI
    service and turn each remote operation into a `<connection>__<tool>`
    `defineAction`. Because they register in the unified action registry, June both
    consumes external MCP/OpenAPI (client) AND re-serves them from its own `/mcp`
    (gateway). Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero
    `node:*`); credentials resolve per call, server-side, and never reach the
    model; a down connection is reported, not thrown.
  - `@junejs/server` — `discoverAgent` now scans `connections/*.ts`, calls
    `connectAll`, merges the remote tools into the agent's tool set, and records the
    connection report on `AgentDefinition.connections`.

- [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2) Thanks [@linyiru](https://github.com/linyiru)! - Make an agent's instructions first-class on the def (no longer silently droppable).

  Previously the system prompt was baked into the `model` at construction
  (`anthropic({ system: buildSystemPrompt(agent) })`), and the runtime def was
  `{ model, tools }` — so instructions were lost at that hand-off unless the caller
  remembered to bake them in.

  Now:

  - `Model` gains an optional `opts.system` (`(msgs, tools, opts?) => reply`) —
    additive, so existing `(msgs, tools)` models and the engine's `model(msgs,
specs)` call are unaffected.
  - `withSystem(model, system)` (`@junejs/core/agent-runtime`) wraps a model to
    carry the system prompt per turn.
  - `AgentDef` / `DoAgentDef` gain `instructions?`; `NativeRuntime` / `MemoryRuntime`
    / `AgentDurableObject` inject it via `withSystem` when building each session —
    single-sourced on the def, impossible to drop. `anthropic()` reads the per-call
    `opts.system` (falling back to its construction-time `system`).

  Bonus: one `anthropic()` model instance can now serve many agents/subagents, each
  supplying its own instructions per turn.

- [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7) Thanks [@linyiru](https://github.com/linyiru)! - Add `@junejs/core/agent-models` — Model-seam provider adapters.

  `anthropic({ model, apiKey?, system?, maxTokens?, thinking? })` turns the
  official `@anthropic-ai/sdk` into the agent runtime's provider-agnostic `Model`
  (streams via `.finalMessage()`; maps the durable transcript ↔ Anthropic Messages,
  folding parallel tool results). The SDK is an **optional peer**, lazy-imported via
  a non-literal specifier, so `@junejs/core` stays installable and typecheckable
  without it and the adapter runs on native _and_ edge (pass `apiKey` on the edge).
  Thinking is off by default until the transcript persists thinking blocks.

- [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e) Thanks [@linyiru](https://github.com/linyiru)! - Add `defineAgent` + directory discovery (agent-runtime build order step 2).

  - `@junejs/core/agent-config` — `defineAgent()` assembles an agent from config +
    tools + skills. `actionToTool()` bridges a `defineAction` into a runtime `Tool`
    (sync ⇒ exactly-once local, async ⇒ at-least-once remote), so an agent's tools
    ARE your server actions — no new tool concept. `readSkillTool` +
    `buildSystemPrompt` give progressive skill disclosure.
  - `@junejs/server/agent-discover` — `discoverAgent(dir)` scans the `agent/`
    directory convention (`agent.ts` + `instructions.md` + `tools/*.ts` +
    `skills/*.md`) into an `AgentDefinition`, ready to mount with
    `createNativeRuntime({ [name]: { model, tools } })`.

- [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090) Thanks [@linyiru](https://github.com/linyiru)! - Add the durable agent-runtime foundation.

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

### Patch Changes

- [#40](https://github.com/junebuild/june/pull/40) [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4) Thanks [@linyiru](https://github.com/linyiru)! - Edge channel routing: mount an agent's inbound channels (Slack/Crisp webhooks, http)
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

- [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8) Thanks [@linyiru](https://github.com/linyiru)! - Fix: keep shipped source erasable (no TS parameter properties).

  June publishes raw `.ts`, so a consumer's `tsc` type-strips our source under
  their flags — and constructor parameter properties (`constructor(private x: T)`)
  are **not** erasable, breaking `erasableSyntaxOnly` and Node's native
  `--experimental-strip-types`. Rewrote every parameter property to an explicit
  field + assignment (`AgentSession`, the native/DO session stores + runtimes,
  `RedisStore`, juno's `Table`).

  Mechanism so it can't recur: **`erasableSyntaxOnly: true` in `tsconfig.base.json`**
  — the root `typecheck` (which `bun run ci` runs, gating publish) now fails on any
  non-erasable syntax (parameter properties, enums, namespaces, `import =`) across
  every package's src and tests.

- [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` so plain Node can consume `@junejs/core`.

  Node refuses to type-strip `node_modules` `.ts`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so importing `@junejs/core`'s raw
  `.ts` from plain Node failed. `@junejs/core` now builds to `dist/` (ESM JS +
  `.d.ts`) via tsdown and uses **dual-condition exports**: `source`/`bun` still
  serve `src/*.ts` (the zero-build inner loop, Bun, opt-in bundlers), while
  `default`/`types` serve built JS + declarations for Node and external `tsc`.
  `june build` resolves `@junejs/*` via a new `source` condition so it keeps
  bundling source (no dist dependency). Second dogfood packaging fix after erasable;
  `@junejs/core` is the pilot — the remaining packages follow.

- [#42](https://github.com/junebuild/june/pull/42) [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94) Thanks [@linyiru](https://github.com/linyiru)! - Worker-side app services: `currentServices()` now resolves in loaders, views, and
  actions — the symmetry twin of the services a Durable Object already seeds for its tools.

  `scope.services` (added for the DO) was only seeded at the DO turn entry, so
  `currentServices()` returned `undefined` everywhere the Worker pipeline runs — a route
  `load()`, a view, or a `defineAction` invoked by the UI/`/mcp`. That made the SAME tool
  behave differently depending on who called it (the agent in the DO vs the UI through the
  pipeline).

  Now the app declares services once in `june.config.ts` and the host seeds them at every
  isolate entry, from that isolate's env:

  - `@junejs/core/config` — `ServicesConfig { make(env): unknown; module }` + `defineServices`
    helper + `JuneConfig.services`. `make(env)` builds the bag from the isolate's env (typed
    `any` so the app writes `(env: MyEnv) => …` without a cast); `module` names the file whose
    `services` export IS `make`, so `june build` can import it into the worker (env only exists
    inside an invocation). Same pattern as `dataLayer`.
  - `@junejs/server` — the pipeline seeds `runInScope({ resources, services })`; dev (`createApp`)
    builds the bag from `process.env`; the generated worker binds it from the worker env,
    memoized per isolate; the build imports the app's factory module into the entry (an
    app-relative path is rebased to the entry dir like a route import; a bare specifier is used
    as-is). Re-exports `defineServices`.

  Additive: no `services` declared → `currentServices()` stays `undefined`, byte-identical
  output. The app can single-source the DO too — `services: config.services.make(this.env)` in
  the DO shell.

## 0.1.0-dev.6

### Patch Changes

- [#42](https://github.com/junebuild/june/pull/42) [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94) Thanks [@linyiru](https://github.com/linyiru)! - Worker-side app services: `currentServices()` now resolves in loaders, views, and
  actions — the symmetry twin of the services a Durable Object already seeds for its tools.

  `scope.services` (added for the DO) was only seeded at the DO turn entry, so
  `currentServices()` returned `undefined` everywhere the Worker pipeline runs — a route
  `load()`, a view, or a `defineAction` invoked by the UI/`/mcp`. That made the SAME tool
  behave differently depending on who called it (the agent in the DO vs the UI through the
  pipeline).

  Now the app declares services once in `june.config.ts` and the host seeds them at every
  isolate entry, from that isolate's env:

  - `@junejs/core/config` — `ServicesConfig { make(env): unknown; module }` + `defineServices`
    helper + `JuneConfig.services`. `make(env)` builds the bag from the isolate's env (typed
    `any` so the app writes `(env: MyEnv) => …` without a cast); `module` names the file whose
    `services` export IS `make`, so `june build` can import it into the worker (env only exists
    inside an invocation). Same pattern as `dataLayer`.
  - `@junejs/server` — the pipeline seeds `runInScope({ resources, services })`; dev (`createApp`)
    builds the bag from `process.env`; the generated worker binds it from the worker env,
    memoized per isolate; the build imports the app's factory module into the entry (an
    app-relative path is rebased to the entry dir like a route import; a bare specifier is used
    as-is). Re-exports `defineServices`.

  Additive: no `services` declared → `currentServices()` stays `undefined`, byte-identical
  output. The app can single-source the DO too — `services: config.services.make(this.env)` in
  the DO shell.

## 0.1.0-dev.5

### Patch Changes

- [#40](https://github.com/junebuild/june/pull/40) [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4) Thanks [@linyiru](https://github.com/linyiru)! - Edge channel routing: mount an agent's inbound channels (Slack/Crisp webhooks, http)
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

## 0.1.0-dev.4

### Patch Changes

- [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` so plain Node can consume `@junejs/core`.

  Node refuses to type-strip `node_modules` `.ts`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so importing `@junejs/core`'s raw
  `.ts` from plain Node failed. `@junejs/core` now builds to `dist/` (ESM JS +
  `.d.ts`) via tsdown and uses **dual-condition exports**: `source`/`bun` still
  serve `src/*.ts` (the zero-build inner loop, Bun, opt-in bundlers), while
  `default`/`types` serve built JS + declarations for Node and external `tsc`.
  `june build` resolves `@junejs/*` via a new `source` condition so it keeps
  bundling source (no dist dependency). Second dogfood packaging fix after erasable;
  `@junejs/core` is the pilot — the remaining packages follow.

## 0.1.0-dev.3

### Minor Changes

- [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2) Thanks [@linyiru](https://github.com/linyiru)! - Make an agent's instructions first-class on the def (no longer silently droppable).

  Previously the system prompt was baked into the `model` at construction
  (`anthropic({ system: buildSystemPrompt(agent) })`), and the runtime def was
  `{ model, tools }` — so instructions were lost at that hand-off unless the caller
  remembered to bake them in.

  Now:

  - `Model` gains an optional `opts.system` (`(msgs, tools, opts?) => reply`) —
    additive, so existing `(msgs, tools)` models and the engine's `model(msgs,
specs)` call are unaffected.
  - `withSystem(model, system)` (`@junejs/core/agent-runtime`) wraps a model to
    carry the system prompt per turn.
  - `AgentDef` / `DoAgentDef` gain `instructions?`; `NativeRuntime` / `MemoryRuntime`
    / `AgentDurableObject` inject it via `withSystem` when building each session —
    single-sourced on the def, impossible to drop. `anthropic()` reads the per-call
    `opts.system` (falling back to its construction-time `system`).

  Bonus: one `anthropic()` model instance can now serve many agents/subagents, each
  supplying its own instructions per turn.

## 0.1.0-dev.2

### Minor Changes

- [`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f) Thanks [@linyiru](https://github.com/linyiru)! - Auto-mount the durable agent from `june.config` (build order step 4).

  - `@junejs/core/config`: an `agent.runtime` block (`enabled` / `dir` / `backend` /
    `chat.path` / `channels`), resolved by `resolveAgent`. `channelFetch` now
    returns `Response | null` so it composes as a fall-through surface.
  - `@junejs/server`: the shared render pipeline gains an `agentSurface` slot (runs
    after the static agent surface `/mcp` + discovery, before middleware/routes).
    `mountAgent` gains `surface` — a framework chat endpoint at `chat.path` (POST
    `{message, session?}` → a durable turn) plus the discovered channels. The dev
    server auto-discovers an `agent/` directory and mounts it with an Anthropic
    model: drop an `agent/` folder and `POST /message`, `/channels/*`, and `/mcp`
    (its tools) are all live — no glue.

  Edge (worker.ts + Durable Object routing) is a follow-up; dev auto-mount ships now.

- [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7) Thanks [@linyiru](https://github.com/linyiru)! - Add `@junejs/core/agent-models` — Model-seam provider adapters.

  `anthropic({ model, apiKey?, system?, maxTokens?, thinking? })` turns the
  official `@anthropic-ai/sdk` into the agent runtime's provider-agnostic `Model`
  (streams via `.finalMessage()`; maps the durable transcript ↔ Anthropic Messages,
  folding parallel tool results). The SDK is an **optional peer**, lazy-imported via
  a non-literal specifier, so `@junejs/core` stays installable and typecheckable
  without it and the adapter runs on native _and_ edge (pass `apiKey` on the edge).
  Thinking is off by default until the transcript persists thinking blocks.

## 0.1.0-dev.1

### Patch Changes

- [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8) Thanks [@linyiru](https://github.com/linyiru)! - Fix: keep shipped source erasable (no TS parameter properties).

  June publishes raw `.ts`, so a consumer's `tsc` type-strips our source under
  their flags — and constructor parameter properties (`constructor(private x: T)`)
  are **not** erasable, breaking `erasableSyntaxOnly` and Node's native
  `--experimental-strip-types`. Rewrote every parameter property to an explicit
  field + assignment (`AgentSession`, the native/DO session stores + runtimes,
  `RedisStore`, juno's `Table`).

  Mechanism so it can't recur: **`erasableSyntaxOnly: true` in `tsconfig.base.json`**
  — the root `typecheck` (which `bun run ci` runs, gating publish) now fails on any
  non-erasable syntax (parameter properties, enums, namespaces, `import =`) across
  every package's src and tests.

## 0.1.0-dev.0

### Minor Changes

- [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3) Thanks [@linyiru](https://github.com/linyiru)! - Add agent channels — inbound edges (http / slack / crisp).

  - `@junejs/core/agent-config` — the `Channel` / `ChannelContext` contract,
    `defineChannel`, and `channelFetch` (a pure Web-standard router that dispatches
    webhook channels by path and http channels by fall-through). `AgentDefinition`
    now carries `channels`.
  - `@junejs/core/channels` — built-in channel factories: `httpChannel` (POST
    /message + optional /mcp), `slackChannel`, `crispChannel`. Web-standard
    (`crypto.subtle` HMAC verification, `fetch` reply-out — zero `node:*`, edge-
    ready). Secrets are injected as options, so the channel stays portable across
    native and edge; loop guards (bot/operator self-messages) prevent reply loops.
  - `@junejs/server` — `discoverAgent` now scans `channels/*.ts`; new `mountAgent`
    builds a `ChannelContext` whose `run` bridges to a durable turn and returns a
    fetch handler (webhooks + http) plus `startAll` for one-shot channels (cli).

- [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d) Thanks [@linyiru](https://github.com/linyiru)! - Add agent connections — outbound tool sources (the mirror of channels).

  - `@junejs/core/connections` — `defineMcpConnection` / `defineOpenapiConnection`
    and `connectAll`: wire an agent into an external MCP server or an OpenAPI
    service and turn each remote operation into a `<connection>__<tool>`
    `defineAction`. Because they register in the unified action registry, June both
    consumes external MCP/OpenAPI (client) AND re-serves them from its own `/mcp`
    (gateway). Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero
    `node:*`); credentials resolve per call, server-side, and never reach the
    model; a down connection is reported, not thrown.
  - `@junejs/server` — `discoverAgent` now scans `connections/*.ts`, calls
    `connectAll`, merges the remote tools into the agent's tool set, and records the
    connection report on `AgentDefinition.connections`.

- [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e) Thanks [@linyiru](https://github.com/linyiru)! - Add `defineAgent` + directory discovery (agent-runtime build order step 2).

  - `@junejs/core/agent-config` — `defineAgent()` assembles an agent from config +
    tools + skills. `actionToTool()` bridges a `defineAction` into a runtime `Tool`
    (sync ⇒ exactly-once local, async ⇒ at-least-once remote), so an agent's tools
    ARE your server actions — no new tool concept. `readSkillTool` +
    `buildSystemPrompt` give progressive skill disclosure.
  - `@junejs/server/agent-discover` — `discoverAgent(dir)` scans the `agent/`
    directory convention (`agent.ts` + `instructions.md` + `tools/*.ts` +
    `skills/*.md`) into an `AgentDefinition`, ready to mount with
    `createNativeRuntime({ [name]: { model, tools } })`.

- [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090) Thanks [@linyiru](https://github.com/linyiru)! - Add the durable agent-runtime foundation.

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

## 0.0.49

### Patch Changes

- [#24](https://github.com/junebuild/june/pull/24) [`a6bc035`](https://github.com/junebuild/june/commit/a6bc0351a7e4c76a4c281b75450ef6250c3734bd) Thanks [@linyiru](https://github.com/linyiru)! - Add a first-class static (GitHub Pages) deploy target.

  - `staticSite()` adapter (`runtime: "static"`): `june build` prerenders every route
    - projection to `dist/static/` (page HTML as `<stem>/index.html`, flat `.md`/`.json`,
      `_june/` assets, `favicon.svg`, `404.html`, `.nojekyll`). `deploy: { target: "static" }`
      resolves it by name — no adapter import. `june deploy` is build-only for this target.
  - `staticPaths` route export: a dynamic catch-all lists the concrete pathnames to
    prerender (locale-expanded), so content-driven routes can ship as static files.
  - `basePath` config: prefixes the framework asset URLs in the rendered document, so a
    site served under a subpath (e.g. a GitHub Pages project path) resolves its assets.

  All additive — `workers()`/`vercel()`/`deno()` and root deploys are unchanged.

## 0.0.48

### Patch Changes

- [#18](https://github.com/junebuild/june/pull/18) [`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c) Thanks [@linyiru](https://github.com/linyiru)! - Configurable content sources: `content.sources` in june.config.ts

  Content no longer has to live under `content/<collection>/`. Config can declare extra source
  directories — including ones outside the app root — that merge into named collections:

  ```ts
  export default defineJune({
    content: {
      sources: [
        { dir: "../docs", collection: "docs" }, // the repo's own docs/, docs-as-code
        { dir: "../schema", collection: "docs", mount: "schema" }, // slugs prefixed schema/…
      ],
    },
  });
  ```

  - Each source scans with the same locale-mirror layout as `content/` (`<dir>/<locale>/…`).
  - `mount` prefixes slugs; a source's root `index.md`/`README.md` becomes the mount's page.
  - A slug collision between sources fails `june gen` loudly, naming both files. A missing
    configured dir is a build error, not a silent skip.
  - Bootstrap-safe: a wrapper-generated config that imports `app/_content.ts` (which only exists
    AFTER the first freeze) self-heals — `june gen` generates the default scan, re-probes the
    config in a fresh subprocess, and regenerates with the sources applied.
  - `june dev` watches configured source dirs (they're outside the app root, invisible to the
    root watcher) and regenerates + restarts on change.

## 0.0.47

### Patch Changes

- [#14](https://github.com/junebuild/june/pull/14) [`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8) Thanks [@linyiru](https://github.com/linyiru)! - fix(client-router): percent-encode the soft-nav title header (non-ASCII titles no longer 500)

  The `fragment` projection put the page title verbatim into the `x-june-title`
  header. HTTP header values are ByteStrings (Latin-1, ≤0xFF), so a non-ASCII
  title — CJK, accents, emoji — threw `TypeError: Cannot convert argument to a
ByteString` at `headers.set`, crashing the whole fragment render with a 500. The
  client router then hit its hard-navigation fallback, so every soft nav to a
  non-ASCII-titled page became a full document reload — the white flash
  `clientRouter` exists to remove (the failure on Node/undici runtimes like
  Vercel's serverless functions; only ASCII-titled pages soft-navigated).

  The server now `encodeURIComponent`s the title before `headers.set`, and the
  three client consumers (morph router, flight router, dev live-reload) decode it
  back with `decodeURIComponent` before assigning `document.title`. ASCII titles
  are unchanged on the wire (`encodeURIComponent("Home") === "Home"`).
