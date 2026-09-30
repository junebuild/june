# @junejs/cli

## 0.1.0-dev.5

### Minor Changes

- [#309](https://github.com/junebuild/june/pull/309) [`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3) Thanks [@linyiru](https://github.com/linyiru)! - `/mcp` and `/api/<id>` validate `Origin` and `Host`, and `june dev` binds `127.0.0.1` ([#308](https://github.com/junebuild/june/issues/308)).

  - **Origin (every host).** MCP 2026-07-28 requires servers to validate `Origin` against DNS rebinding and to answer an invalid one with 403. `mcpHandler` and `apiHandler` take an `OriginPolicy`. A request without an `Origin` passes, because CLIs, SDKs, and server-side connectors don't send one. A present `Origin` must be the request's own or listed in `agent.allowedOrigins`. Otherwise the answer is `403`: on `/mcp` a JSON-RPC error with no `id` (`-32000`), on `/api` `{ error: { code: "forbidden" } }`.
  - **CORS for listed origins.** A cross-origin browser app in `agent.allowedOrigins` gets its preflight answered (`POST`, the requested headers) and responses with `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`. Same-origin calls get no CORS headers.
  - **Checked before identity.** The pipeline applies the policy before `identity(request)`, so a refused call triggers no resolver I/O, and a throwing resolver can't turn the 403 into a 500. `mcpForbidden` and `apiForbidden` build the same 403 bodies for custom hosts. `GET /api` and every OpenAPI operation now list the `forbidden` / 403 response.
  - **Host (DNS rebinding).** After a rebind the attacker's page is same-origin, so only `Host` gives it away. When `agent.allowedHosts` is set, `Host` must be an IP literal or match an entry: `"example.com"`, or `".example.com"` for it and its subdomains. `june dev` always allows `localhost` and `.localhost`. The official conformance scenario `dns-rebinding-protection` now passes on both protocol eras.
  - **BREAKING (dev only): `june dev` binds `127.0.0.1`.** It used to listen on every interface. `june dev --host` restores that, and `--host <addr>` binds one address (the printed URL follows it). Behind a tunnel, add its domain to `agent.allowedHosts` (e.g. `".trycloudflare.com"`) to reach `/mcp` and `/api`. Production (`june start`, Workers) binds and routes as before.
  - Malformed `allowedOrigins` or `allowedHosts` entries fail when the config resolves. `originRejection` and `OriginPolicy` are exported from `@junejs/core/mcp` for custom hosts.

### Patch Changes

- Updated dependencies [[`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3), [`10b0119`](https://github.com/junebuild/june/commit/10b01190b98521890b36e599b1953bfca635625e), [`29504fe`](https://github.com/junebuild/june/commit/29504fe04c286b76b0d9727b1d222910ad5a9c82)]:
  - @junejs/core@0.2.0-dev.65
  - @junejs/server@1.0.0-dev.45

## 0.1.0-dev.4

### Minor Changes

- [#296](https://github.com/junebuild/june/pull/296) [`f2e0042`](https://github.com/junebuild/june/commit/f2e00429745c044d4fa31786f0d2fa2403e3d8d2) Thanks [@linyiru](https://github.com/linyiru)! - External subcommands: `june <verb>` that is not built in runs `june-<verb>` ([#295](https://github.com/junebuild/june/issues/295)).

  The git / cargo model, for clients that ship on their own — first, the operator inbox
  (`@junejs/inbox` behind `june inbox`, email RFC §9.3):

  - Looked up in `node_modules/.bin` from the working directory up (hoisted bins included), then
    on `PATH`. Built-in verbs always win; a verb must be a plain lowercase name, so `june ../x`
    never resolves.
  - The arguments are passed exactly as typed (June's parser never sees them), the terminal is
    inherited, the exit code is returned (128 + the signal when it is killed), and SIGTERM /
    SIGHUP are forwarded.
  - On Windows, a `.cmd` / `.bat` target runs through `cmd.exe` with cross-spawn's escaping: every
    argument quoted and its metacharacters `^`-escaped (twice for an npm shim). Verified on
    Windows 11 with 23 hostile arguments through both an npm `.cmd` shim and a bun `.exe` shim:
    all arrived literally, nothing was injected — where a plain `cmd.exe /c` split `a&b` and ran
    `b` as a command.
  - **The `june` launcher (`bin.mjs`) relays signals.** It waited on Bun with `spawnSync`, so a
    SIGTERM / SIGHUP sent to the `june` pid killed the Node wrapper and orphaned Bun — and
    whatever Bun ran: `june dev`, or an external command. It now runs Bun asynchronously,
    relays SIGTERM / SIGHUP, and mirrors the exit (128 + the signal). SIGINT is caught and
    relayed only without a terminal: Ctrl-C in a terminal already reaches the whole foreground
    group, and a second SIGINT would force what should be a graceful stop — verified through a
    PTY (exactly one SIGINT arrives; relaying always sent two).
  - A table of first-party external verbs feeds `june help` and an install hint when one is
    missing; it stays empty until `@junejs/inbox` publishes.
  - An unknown verb says where it looked.

### Patch Changes

- Updated dependencies [[`981aa5c`](https://github.com/junebuild/june/commit/981aa5c54aeaf557fcdd4efe63300a2f78aaa306)]:
  - @junejs/core@0.2.0-dev.62
  - @junejs/server@1.0.0-dev.41

## 0.0.52-dev.3

### Patch Changes

- [#235](https://github.com/junebuild/june/pull/235) [`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349) Thanks [@linyiru](https://github.com/linyiru)! - Actions are now also plain HTTP: `POST /api/<id>` + `/openapi.json`.

  - Every rich `defineAction` (one with a description, the same set `/mcp` lists)
    is also `POST /api/<id>`: the JSON body is the input and the JSON response is
    the result. It goes through the same `invokeAction`, with the same
    `createPipeline({ identity })` principal as `/mcp`, so `requiresPrincipal`
    and schema validation hold on this surface too. Only an action's canonical
    path (`/api/` + `encodeURIComponent(id)`) is claimed, and every other
    `/api/*` path still falls through to the app's routes.
  - Errors have one shape, `{ error: { code, message, hint? } }`, classified the
    same way as `/mcp` (via `actionDispatchCode`): `invalid_input` (400) and
    `unauthorized` (401) are invokeAction's own refusals; anything the action
    throws — including a nested dispatch refusal it lets escape — is
    `execution_error` (500, message only, never a stack). Transport codes:
    `invalid_json` (400), `not_found` (404), `method_not_allowed` (405, with
    `Allow: POST`), `unsupported_media_type` (415). A JSON `Content-Type` is
    required (an RFC 9110 media type whose type/subtype is `application/json` or a
    `+json` type), so a cross-site browser request is always CORS-preflighted and
    can't reach an action with a simple form post.
  - `GET /openapi.json` returns an OpenAPI 3.1 document generated from the
    registry: one POST operation per action, with `operationId` = the action id,
    `summary`/`description`, the input schema as a required request body (send
    `{}` when a tool takes no input), and typed 200 and error responses (a shared
    `Error` schema). An action's MCP `annotations` appear as `x-mcp-annotations`.
  - The HTTP API is one more `agentServices()` entry, so it is advertised
    everywhere the MCP server is: the homepage `Link` header
    (`rel="service-desc"`), the RFC 9727 api-catalog (an `item` with its
    `service-desc`), the ARD / AI Catalog (an `api` entry), the generated
    SKILL.md ("Act (HTTP)"), an llms.txt "HTTP API" section, the actionable 404,
    and `june info`. Its media type is `application/json` everywhere, from one
    constant (`OPENAPI_MEDIA_TYPE`): IANA registers no OpenAPI media type. A
    static build projects it out with MCP — no server, nothing advertised.
  - New `agent.api` flag: on by default, off with `agent.enabled: false`. New
    subpath: `@junejs/core/api` (`apiHandler`, `apiActionId`, `apiActionPath`,
    `isRoutableActionId`, `isJsonContentType`, `OPENAPI_MEDIA_TYPE`,
    `openApiDocument`). An action id that cannot be a URL path segment (`""`,
    `"."`, `".."`, or one that can't be encoded at all) stays valid for
    `defineAction` and `/mcp` but is left off this surface, with a one-time
    warning.

- Updated dependencies [[`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349), [`cde48a2`](https://github.com/junebuild/june/commit/cde48a28d8a532b2d5d549d569894dff28caba39), [`eac1daa`](https://github.com/junebuild/june/commit/eac1daa276c2f2f94ca1d98f2306a83a5a88563f), [`18cc523`](https://github.com/junebuild/june/commit/18cc523dabecf56ef510e64ce0b94edf02ce9e02), [`c54a6f0`](https://github.com/junebuild/june/commit/c54a6f08547413c9a020b673b7181ea9fb496b01)]:
  - @junejs/core@0.2.0-dev.51
  - @junejs/server@1.0.0-dev.31

## 0.0.52-dev.2

### Patch Changes

- [#140](https://github.com/junebuild/june/pull/140) [`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828) Thanks [@linyiru](https://github.com/linyiru)! - Agent directory compile — the agent/ convention mounts on the edge ([#139](https://github.com/junebuild/june/issues/139)).

  `discoverAgent` is fs-based and native-only, so every edge consumer hand-assembled what the directory already declares: statically imported tools in a hand-maintained registry, instructions bundled via the wrangler `[[rules]]` Text hack (plus a mirroring vitest md-loader and `readFileSync` in Node scripts — three loaders kept honest only by discipline), manually wired `channelInstructions`, and no skills at all — nothing on the edge synthesized `read_skill`, so authored `skills/*.md` were inert. `june gen` now compiles the directory into `agent/_agent.gen.ts`: static imports for code (tools/channels/connections), prose inlined as string literals (instructions, channel overlays, skills — parsed at init by core's `parseSkill`, so a parser improvement never requires regeneration). Plain erasable TypeScript: bundles under wrangler/Rolldown, imports under bun test and Node type stripping, no loader plugins anywhere. `june gen --check` (and plain `git diff --exit-code` after `june gen`) is the CI staleness gate; `.ts` import extensions are kept when the consumer's tsconfig enables `allowImportingTsExtensions` (Node type-stripping consumers), dropped otherwise.

  One assembly path, two targets — `@junejs/core/agent-config` gains the shared entry points both runtimes go through, so native discovery and the compiled module cannot drift. `AgentModule` is the raw directory shape (channels stay unresolved factories; connections stay definitions — both resolve where the agent actually runs). `assembleAgent(module, env)` is the native side: resolves channel factories, wires connections (`connectAll`), hands everything to `defineAgent` — `discoverAgent` is now a thin fs scan feeding it. `assembleDurable(module)` is the DO side: adapted tools + a synthesized `read_skill`, the system prompt pre-composed with the skill index (`buildSystemPrompt`), channel factories passed through untouched for the DO to resolve with its own env — spread it into `new AgentDurableObject(ctx, { ...assembleDurable(agentModule), model, env, services })`. Skills therefore mount on the Durable Object target for the first time.

  The directory convention grows two pieces the first real consumer already reached for: `channels/<source>.md` is discovered as that channel's `channelInstructions` overlay (native and compiled alike), and skill frontmatter supports `when-to-use` (hyphenated keys now parse; `Skill.whenToUse` rides the prompt's skill index line so the model can decide whether to load a body without spending a tool call). `parseSkill` moved to `@junejs/core/agent-config` — pure, shared by discovery, the compiled module, and tests. `_`-prefixed files under an agent directory are now private by convention (never scanned), which is also what keeps `_agent.gen.ts` itself out of the scan. `examples/agent-edge` is restructured to the compiled pattern: the definition lives in `agent/`, the worker keeps only the DO shell (model + env wiring) and the routed surfaces.

  Follow-up (tracked in [#139](https://github.com/junebuild/june/issues/139)): `june build` sets `WorkerManifest.agentName` and emits the DO class + wrangler `durable_objects`/`migrations` bindings so a June-native app's edge auto-mounts with zero hand-written worker; lazy connection wiring in the DO.

- Updated dependencies [[`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828)]:
  - @junejs/core@0.2.0-dev.33
  - @junejs/server@1.0.0-dev.15

## 0.0.52-dev.1

### Patch Changes

- Updated dependencies [[`fea4078`](https://github.com/junebuild/june/commit/fea407877de98adda39c2f277d45157ea9a8d6f0)]:
  - @junejs/core@0.2.0-dev.26
  - @junejs/server@1.0.0-dev.10

## 0.0.52-dev.0

### Patch Changes

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.0
  - @junejs/server@0.1.2-dev.0

## 0.0.51

### Patch Changes

- [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
  them too.

  Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
  `@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
  `dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
  `source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
  bundlers), while `default`/`types` serve built JS + declarations for Node and
  external `tsc`. Notes per package:

  - `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
    `default` each map to the right built entry; the OG renderers (`workers-og`,
    `@vercel/og`) stay external so their WASM is never bundled.
  - `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
    runs `src/june.ts` raw under Bun.

  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
  workspace.

- Updated dependencies [[`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f), [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa), [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77), [`af8c0a7`](https://github.com/junebuild/june/commit/af8c0a7b34f90b113b54d9230806612f5d7d89e3), [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2), [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090), [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4), [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8), [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc), [`9dc99d5`](https://github.com/junebuild/june/commit/9dc99d5bd0851bdd1aa261311ce108e697b85b3f), [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94)]:
  - @junejs/core@0.1.0
  - @junejs/server@0.1.0

## 0.0.51-dev.1

### Patch Changes

- [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
  them too.

  Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
  `@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
  `dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
  `source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
  bundlers), while `default`/`types` serve built JS + declarations for Node and
  external `tsc`. Notes per package:

  - `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
    `default` each map to the right built entry; the OG renderers (`workers-og`,
    `@vercel/og`) stay external so their WASM is never bundled.
  - `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
    runs `src/june.ts` raw under Bun.

  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
  workspace.

- Updated dependencies [[`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc)]:
  - @junejs/core@0.1.0-dev.4
  - @junejs/server@0.1.0-dev.5

## 0.0.51-dev.0

### Patch Changes

- Updated dependencies [[`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090)]:
  - @junejs/core@0.1.0-dev.0
  - @junejs/server@0.1.0-dev.0

## 0.0.50

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
  - @junejs/server@0.0.51
