# @junejs/db

## 0.0.33-dev.2

### Patch Changes

- [#38](https://github.com/junebuild/june/pull/38) [`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa) Thanks [@linyiru](https://github.com/linyiru)! - Make the Durable Object a first-class scope root, so tools reach ambient `db` and
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

## 0.0.33-dev.1

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

## 0.0.33-dev.0

### Patch Changes

- Updated dependencies [[`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090)]:
  - @junejs/core@0.1.0-dev.0
