# @junejs/core

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
