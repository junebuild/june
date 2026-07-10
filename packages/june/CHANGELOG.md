# @junejs/server

## 0.1.0-dev.5

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

- Updated dependencies [[`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd), [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc)]:
  - @junejs/db@0.0.33-dev.1
  - @junejs/core@0.1.0-dev.4

## 0.1.0-dev.4

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

### Patch Changes

- Updated dependencies [[`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2)]:
  - @junejs/core@0.1.0-dev.3

## 0.1.0-dev.3

### Patch Changes

- [`af8c0a7`](https://github.com/junebuild/june/commit/af8c0a7b34f90b113b54d9230806612f5d7d89e3) Thanks [@linyiru](https://github.com/linyiru)! - Route the durable agent chat endpoint to a per-session Durable Object on the edge.

  `durableAgentSurface(getNamespace, { agentName, chatPath })` forwards `POST
<chat.path>` to the session's DO (`env.AGENT`, addressed by `idFromName`), and
  `createWorker` mounts it when `manifest.agentName` is set and the runtime is
  enabled — inert (falls through) when no DO is bound, so existing workers are
  unaffected. Tested with a fake DurableObjectNamespace (the repo's fake-bindings
  discipline; the DO logic is covered by the fake-SqlStorage tests).

  Follow-up to make it live on a real deploy: the build must discover the agent/
  directory to set `manifest.agentName`, bundle the app's `JuneAgentDO`, and emit
  the wrangler DO binding + migration. Channel webhooks on the edge (session from
  the platform payload) also remain a follow-up.

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

### Patch Changes

- Updated dependencies [[`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f), [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7)]:
  - @junejs/core@0.1.0-dev.2

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

- Updated dependencies [[`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8)]:
  - @junejs/core@0.1.0-dev.1

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

- [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77) Thanks [@linyiru](https://github.com/linyiru)! - Add the Durable Object edge target + selectable agent-runtime backends.

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

- Updated dependencies [[`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090)]:
  - @junejs/core@0.1.0-dev.0
  - @junejs/db@0.0.33-dev.0

## 0.0.59

### Patch Changes

- [#34](https://github.com/junebuild/june/pull/34) [`b0e7f77`](https://github.com/junebuild/june/commit/b0e7f77b2d8317e5e15c6a3b5b8069d9bfdf0b5f) Thanks [@linyiru](https://github.com/linyiru)! - Resolve `deploy.target` to the built-in adapter at BUILD time (not just "static")

  The build only special-cased `deploy.target === "static"` (→ `staticSite()`); every other
  target — including `"vercel"` and `"deno"` — silently fell back to `workers()`. So a purely
  DECLARATIVE config that can't express a `vercel()` call (e.g. `kura.toml`'s `[deploy] target =
"vercel"`) was packaged as a Cloudflare Workers bundle instead of a Vercel one. (`deploy.ts`
  already resolved all four targets by name for the deploy VERB, so build and deploy disagreed.)

  The adapter resolution is now `resolveDeployAdapter(deploy)` (exported): an explicit `adapter`
  instance still wins, otherwise the `target` name selects the matching built-in —
  `static`/`vercel`/`deno`/`workers` — defaulting to `workers()`. This puts build in lockstep with
  `deploy.ts`, so `kura.toml` (or any string-only config) can target Vercel/Deno without importing
  the adapter factory. `vercel()`/`deno()` use their default opts (runtime/regions, org/app aren't
  carried on `JuneConfig.deploy` yet). Passing an `adapter` instance is unchanged.

## 0.0.58

### Patch Changes

- [#32](https://github.com/junebuild/june/pull/32) [`c15f14e`](https://github.com/junebuild/june/commit/c15f14ecb82f1646fda190c6d2bc8648944b84b3) Thanks [@linyiru](https://github.com/linyiru)! - fix(build): seed the config's app/\_content imports so external-only content.sources bootstraps

  A docs-as-code app keeps ALL content in external `content.sources` (e.g. the repo's own
  `../docs`) with NO local `content/`. On a FRESH build the generated config imports
  `app/_content.ts` (`import { DOCS } from "./app/_content"`), which the first freeze creates —
  so `generateContent`'s bootstrap runs its two-pass: default scan → re-probe the config →
  regenerate with the real sources. But with no local `content/`, Pass 1's default scan finds
  zero collections and writes nothing, so the re-probe's config load STILL fails on the missing
  `DOCS` export → the sources are dropped → `kura index: app/_content.ts not found` and the build
  fails. (It only appeared to work locally when a stale `app/_content.ts` lingered from a prior
  build; a clean CI/Vercel build has none.)

  The bootstrap now seeds `app/_content.ts` with empty stubs for the EXACT names the config
  imports from it (scanned from the config text), so the re-probe loads even before any content
  exists. Apps with local `content/` are unaffected (Pass 1 already seeds them); the seed is
  overwritten by the real freeze that follows a successful probe.

## 0.0.57

### Patch Changes

- [#30](https://github.com/junebuild/june/pull/30) [`25afd3b`](https://github.com/junebuild/june/commit/25afd3b5cdaca9b5026a2356a66f4c7d19bfe9ab) Thanks [@linyiru](https://github.com/linyiru)! - Static prerender: a locale home's .md/.json projections are requested as "/<locale>/index.md" and emitted at "<locale>/index.md", mirroring the root home. "/<locale>.md" has no "/" boundary, so the locale matcher could not strip the prefix and the request fell into the docs catch-all as a phantom slug (a hard 404 on Kura sites, a silently wrong file otherwise). Unblocks i18n static sites.

## 0.0.56

### Patch Changes

- [#29](https://github.com/junebuild/june/pull/29) [`a0023b8`](https://github.com/junebuild/june/commit/a0023b8192c6d0392f229cb434cff5394b2f7378) Thanks [@linyiru](https://github.com/linyiru)! - Fix fresh-build slug flattening: key the content-entry memo by (file, slug, locale), not file alone. The bootstrap two-pass in generateContent scans the same files twice in one process (pass 1 with regex-guessed locales, pass 2 with the declared set); the file-keyed memo handed pass 1's entry (where a 2-3 letter folder like docs/adr/ was mistaken for a locale bucket, producing flat slugs) back to pass 2, freezing wrong slugs into app/\_content.ts on every fresh CI build while warm local builds looked correct.

## 0.0.55

### Patch Changes

- [`336f017`](https://github.com/junebuild/june/commit/336f017cabca77a451f9a36a10aa36686eb81bfc) Thanks [@linyiru](https://github.com/linyiru)! - Content: a doc's title falls back to its first H1 when the frontmatter has no `title:`.

  So plain Markdown with no front-matter still gets a real title (from its `# Heading`) instead
  of defaulting to the slug — "point June at a docs/ folder, change nothing" now holds. A
  frontmatter `title:` still wins; a doc with neither has an undefined title as before.

## 0.0.54

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

- Updated dependencies [[`a6bc035`](https://github.com/junebuild/june/commit/a6bc0351a7e4c76a4c281b75450ef6250c3734bd)]:
  - @junejs/core@0.0.49

## 0.0.53

### Patch Changes

- [#22](https://github.com/junebuild/june/pull/22) [`29fa978`](https://github.com/junebuild/june/commit/29fa978778afb3e8c617b8c87f8ba291b36d9524) Thanks [@linyiru](https://github.com/linyiru)! - Locale buckets are now DECLARED, not guessed — `content/docs/cli/` is content, not a locale

  The content freeze detected locale mirrors by folder shape (a BCP-47-ish regex), so ANY
  2–3-letter top-level folder — `cli/`, `sdk/`, `api/`, `faq/`, `dev/` … — was silently treated
  as a locale bucket and dropped from the default set (its pages never reached `app/_content.ts`).

  `june gen` now takes the locale set from config `i18n` (defaultLocale + `locales` keys):

  - Only declared dirs split off as locale mirrors; everything else is content.
  - **No `i18n` config ⇒ no locale buckets at all** — an undeclared locale is not a locale. If you
    relied on shape-detected mirrors without declaring `i18n`, declare it.
  - The shape regex remains only as the fallback when june.config.ts itself cannot be loaded
    (the wrapper-CLI bootstrap pass), and the bootstrap re-probe carries the declared set.

  `scanCollection`/`collection`/`entry`'s optional `knownLocales` parameter semantics are
  unchanged; the fix is that the freeze now actually passes it.

## 0.0.52

### Patch Changes

- [#20](https://github.com/junebuild/june/pull/20) [`4f6d26a`](https://github.com/junebuild/june/commit/4f6d26ac011d3121f6c6533712b31462c623c19a) Thanks [@linyiru](https://github.com/linyiru)! - Silence two spurious build warnings

  - `CONFIGURATION_FIELD_CONFLICT` no longer fires when the app's tsconfig declares
    `jsxImportSource: "@junejs/core"`: the v0.0.41 skip only covered the worker bundle — the
    CLIENT bundle still set `transform.jsx.importSource` unconditionally. Both passes now share
    one `jsxTransform` helper. The tsconfig reader is also JSONC-tolerant now (comments and
    trailing commas are idiomatic tsconfig; a strict-parse failure silently regressed to
    "not declared" and brought the warning back).
  - `UNRESOLVED_IMPORT react-server-dom-webpack/client.browser` no longer prints on every client
    bundle. That dynamic import (client-router-flight's decoder) is intentionally optional: morph
    apps don't install it, the runtime `import()` rejects, and the navigation hard-falls-back by
    design. The client bundle's `onLog` now silences exactly that log — real unresolved imports
    still warn.

## 0.0.51

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

- Updated dependencies [[`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c)]:
  - @junejs/core@0.0.48

## 0.0.50

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

- Updated dependencies [[`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8)]:
  - @junejs/core@0.0.47

## 0.0.49

### Patch Changes

- [#12](https://github.com/junebuild/june/pull/12) [`bc16ba0`](https://github.com/junebuild/june/commit/bc16ba058a05de952691ebca6a78ce36b3e8dd4d) Thanks [@linyiru](https://github.com/linyiru)! - fix(build): lazy-load oxc-parser in the island registry so it stays out of the runtime bundle

  `island-registry.ts` imported `parseSync` from `oxc-parser` at module top level. oxc-parser eagerly loads a native/wasm binding on import, and `rsc-manifest.ts` (reachable from the runtime worker) pulls this module in for its lightweight helpers (`walk`, `exportNames`, `firstStatementIsDirective`) — none of which need oxc. That dragged oxc-parser's binding into the worker bundle, crashing targets that don't ship it: a Vercel Node function failed with `Cannot find package '@oxc-parser/binding-wasm32-wasi'` (`FUNCTION_INVOCATION_FAILED`). The Workers bundle tree-shakes the chain differently and was unaffected.

  `oxc-parser` is now dynamic-imported inside `generateIslandRegistry` (its only consumer, which runs at build time only). The function becomes async; its two build-time call sites (`build.ts`, `app.ts`) await it.

## 0.0.48

### Patch Changes

- [#10](https://github.com/junebuild/june/pull/10) [`b83df35`](https://github.com/junebuild/june/commit/b83df356771e44818004562640f7e7ff4e476c6d) Thanks [@linyiru](https://github.com/linyiru)! - Render content markdown with @momiji-rs/sparkdown/gfm (wasm) instead of marked

  The content pipeline now renders `entry.html` via `@momiji-rs/sparkdown/gfm` — a WASI-free WebAssembly
  CommonMark + GFM renderer — replacing `marked`. Benchmarked on real docs (Bun): ~75× faster on small
  pages and ~580× faster on large pages (marked degrades super-linearly: a 27KB page took ~130ms; the
  same page renders in ~0.22ms), with GFM (tables, strikethrough, task lists, autolinks) at no extra
  cost. Output is CommonMark-strict: headings stay bare (`<h2>…`), code fences keep `language-*`, and a
  bare `{…}` is literal text. The wasm initializes once per process; this module is build/dev-only, so it
  never enters the worker bundle.
