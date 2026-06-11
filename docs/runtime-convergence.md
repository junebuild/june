# Phase 4 — native runtime convergence

> The only phase with real unknowns; everything before it was porting. This doc
> is the engineering plan: what the native runtime is, how it renders @junejs/core
> semantics, what landed, and what remains.

## The goal

`june dev` IS the native binary. The Bun dev server (Phase 2) demotes to a
fallback. The native runtime (`runtime/`, deno_core 0.403 + V8) hosts a @junejs/core
app and serves the SAME surfaces the dev server and built worker serve — the
golden parity contract (Phase 3) extends to a third renderer.

## Why convergence is cheap at the SSR layer (and where it is not)

Phase 3 already did the load-bearing work: the request pipeline
(`@junejs/server/pipeline`) is **worker-safe** — @junejs/core (pure) + react only,
no `node:*`, no `Bun.*`. `createWorker(manifest)` is a Web-standard
`fetch(Request) => Response` built from a frozen manifest. That is exactly the
shape a V8 isolate wants:

```
        ┌─────────────────────── one render core (pipeline.ts) ───────────────────────┐
Bun dev server  ──fs resolver──┐                                                       │
built worker    ──manifest─────┤──> discovery · mcp · projections · Document · layouts │
NATIVE runtime  ──manifest─────┘   (renderToReadableStream — present in every build)   │
        └──────────────────────────────────────────────────────────────────────────────┘
```

So the **baseline convergence** is: the native runtime loads the @junejs/core
pipeline JS into its isolate and calls `createWorker(manifest).fetch(request)`
per HTTP request. No re-implementation, so native SSR surfaces are
byte-equivalent to dev/worker by construction. The Rust side is plumbing:
`axum` request → op → JS handler → `Response` → `axum`.

What is NOT cheap — the actual unknowns — is the layer the native runtime adds
ON TOP, which our pipeline does not have yet (it is SSR-only today):

1. **RSC / Flight.** The pipeline renders HTML via `renderToReadableStream`.
   The native runtime's value is React Server Components: render to a Flight
   stream, ship it, hydrate on the client, and push new Flight on change.
2. **Two React graphs in one isolate.** The proven `JuneLoader` resolves the
   same `import "react"` to the `react-server` build (server graph → Flight) or
   the normal build (client graph → SSR + hydrate), per import chain. This is
   the innovation that lets dev HMR be the production live path.
3. **Live-RSC push HMR.** On a server-component edit, re-render the active
   routes' Flight and push it over WebSocket/SSE; the client reconciles in place
   with client state preserved.
4. **The one transpile funnel.** TS/JSX → (optional React Compiler pre-pass) →
   type-strip-keep-JSX → JSX transpile, in the loader. `JUNE_REACT_COMPILER=1`.
5. **V8 snapshot + listen-early.** Vendors baked into the snapshot module map
   under `june://vendor/*` specifiers; ~12ms cold isolate boot vs ~123ms.

## What landed this phase

- **The runtime is in the monorepo.** `runtime/` is now a self-contained Cargo
  workspace ported from the proven reference (deno_core 0.403, ~2.8k lines Rust:
  `src/main.rs` snapshot binary, `src/bin/apploader.rs` module-loader runtime,
  `build.rs` snapshot baker). The PoC's cross-path coupling (build.rs read a
  sibling `../runtime/dist`) is fixed — vendors load from the local `dist/`.
- **Build chain documented + validated.** `bun runtime/build.ts` emits the
  `dist/*` bundles the snapshot bakes, then `cargo build` produces the binaries.
- The pins stay isolated in their own workspace (rebuild-plan Phase 0).

## What remains (the convergence frontier)

The native runtime today renders its OWN file-routed RSC demo (ported `js/` +
`app/`), not @junejs/core `route()` definitions. Bringing it under Phase-1 semantics:

1. **@junejs/core render entry.** Replace the runtime's `entry-server`/`entry-ssr`
   with an entry that imports the @junejs/core pipeline + the app's frozen manifest
   (the Phase-3 `buildManifest` output) and exposes `fetch`. Bundle @junejs/core +
   `@junejs/server/pipeline` into the runtime's vendor set (build.ts) so the
   isolate resolves them. **Acceptance: the native binary passes
   `parity.test.ts` as a third renderer.**
2. **Flight projection.** Add a `flight` projection to the pipeline (alongside
   view/json/agent/md) that renders RSC through the server graph. This is where
   the `JuneLoader` dual-graph resolution plugs in — `route().view` becomes a
   server component; `"use client"` islands hydrate.
3. **Live-RSC HMR over the @junejs/core route table.** Reuse the proven watcher +
   epoch + push loop, keyed by @junejs/core's active routes.
4. **Transpile funnel under @junejs/core.** The loader already type-strips + runs
   the React Compiler pre-pass; point it at the @junejs/core app dir; keep ONE funnel.
5. **Demote the Bun dev server.** `june dev` dispatches to the native binary when
   present, falling back to `@junejs/server`'s `startDevServer`.

## Parity is the acceptance test

Every step above is gated by the same contract: the native runtime's surfaces
must be byte-equivalent to the dev server and built worker for the SSR
projections, and the Flight projection must hydrate to the same DOM. `june dev`
earning the native path means earning a green `parity.test.ts` against it.
