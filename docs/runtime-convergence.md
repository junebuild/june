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
   The native runtime's value is on the SERVER: render React Server Components
   to a Flight stream, ship it, and push a new stream on change. How that update
   is *applied* to a live client DOM is a separate decision — see
   [The client-apply layer](#the-client-apply-layer--route-a-embrace-react-morph-the-shell):
   morph by default, Flight reconcile opt-in.
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

## The client-apply layer — Route A (embrace React, morph the shell)

The native runtime adds power on the SERVER (stream, push, project). But every
update still has to be APPLIED to a live client DOM, and *that* is a fork with a
verified constraint behind it. We commit to **Route A: keep React for
interactivity, let June own only the shell + navigation + live-apply, and apply
updates by morphing — never by mutating React-owned DOM.** We converge with
React on the web platform instead of replacing it on the client.

### Three layers, not one mechanism

| Layer | What updates it | Whose job | Coexist? |
| --- | --- | --- | --- |
| Inside an island | `useState` / effects / props | React's reconciler | **always** — June never replaces it |
| Page nav / live update | swap new content into `[data-june-root]` | **morph (default)** · Flight reconcile (opt-in) | the two are *alternatives* — pick per route, never stacked |
| Move a node, keep its state | reparent without reset | `moveBefore()` | **shared primitive** — both layers use it |

The only fork is the middle layer. The top layer (React inside islands) and the
primitive layer (`moveBefore`) are shared and permanent.

### The constraint is law, not taste

React forbids outside code from mutating the DOM it manages — *"Modifying,
adding children to, or removing children from elements that are managed by React
can lead to inconsistent visual results or crashes"*
([react.dev, Manipulating the DOM with Refs](https://react.dev/learn/manipulating-the-dom-with-refs)).
So the morph applier treats every `<june-island>` as **opaque**: it morphs the
server-rendered shell and an island's *position*, and NEVER recurses into an
island's interior. The same rule is why a persisted island is relocated with
`moveBefore()` (state-preserving reparent), not `insertBefore` — and React core
is adopting the same primitive for the same reason
([facebook/react #31596](https://github.com/facebook/react/pull/31596),
[#32036](https://github.com/facebook/react/pull/32036);
[WHATWG DOM #1255](https://github.com/whatwg/dom/issues/1255), whose motivation
explicitly cites HTMX). Standards-first means we move *with* React here, not
against it.

### Why morph is the default applier (and Flight the opt-in)

- **morph is HTML-over-the-wire.** What we apply is the SAME complete,
  projectable document every URL already serves — no second wire format, the
  agent surface ([MCP](/docs/features-mcp), `.md`/`.json`) is untouched, and it
  degrades to a hard navigation. It is the mature standard of the hypermedia
  camp (idiomorph / Turbo 8 / Phoenix LiveView / htmx) — exactly June's
  identity. Island state, focus, scroll, and open connections in unchanged
  nodes survive *by default*, no per-island annotation required (a layout
  island has a stable key; a page island a route-scoped one).
- **Flight is VDOM-over-the-wire.** Finer-grained, streaming, React-native — but
  it couples the framework to `react-server-dom` + client references and ships a
  payload that is NOT a projectable document. We keep it as an OPT-IN apply path
  for the routes that genuinely need streamed, fine-grained reconcile.
- **Net:** the native runtime's investment is server-side — native streaming
  fragments and Live-push *generation*. The client *applies* them by morph.
  Flight is a capability, not the default; reach for it per route, eyes open to
  the coupling.

### What this changes in the frontier below

- The **Flight projection** (step 2) stays, but as the OPT-IN apply path, not the
  only client story. Its default sibling is a **fragment projection** — the
  `[data-june-root]` inner HTML for a nav/live request (+ the title in a header)
  — applied by morph.
- **Live-RSC HMR** (step 3): "reconcile in place" defaults to **morphing pushed
  HTML** (the LiveView model); Flight reconcile is the opt-in for RSC routes.
  Client island state is preserved either way — by island opacity + `moveBefore`.

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
2. **Fragment + Flight projections.** Add a `fragment` projection (the
   `[data-june-root]` inner HTML + title header) as the DEFAULT soft-nav/live
   apply path — morphed in on the client. Add a `flight` projection alongside it
   (renders RSC through the server graph, where the `JuneLoader` dual-graph
   resolution plugs in — `route().view` a server component, `"use client"`
   islands hydrate) as the OPT-IN apply path. See
   [The client-apply layer](#the-client-apply-layer--route-a-embrace-react-morph-the-shell).
3. **Live-RSC HMR over the @junejs/core route table.** Reuse the proven watcher +
   epoch + push loop, keyed by @junejs/core's active routes. The client applies a
   pushed update by **morphing the fragment** by default (island state preserved
   by opacity + `moveBefore`); Flight reconcile is the opt-in for RSC routes.
4. **Transpile funnel under @junejs/core.** The loader already type-strips + runs
   the React Compiler pre-pass; point it at the @junejs/core app dir; keep ONE funnel.
5. **Demote the Bun dev server.** `june dev` dispatches to the native binary when
   present, falling back to `@junejs/server`'s `startDevServer`.

## Parity is the acceptance test

Every step above is gated by the same contract: the native runtime's surfaces
must be byte-equivalent to the dev server and built worker for the SSR
projections; the fragment projection morphed into a live page must yield the
SAME DOM as a full load of that URL (minus preserved-island state); and the
Flight projection must hydrate to the same DOM. `june dev` earning the native
path means earning a green `parity.test.ts` against it.
