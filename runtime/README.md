# runtime/ — the native June runtime (Phase 4)

A standalone Cargo workspace (deno_core 0.403 + V8), isolated from every other
crate graph so its `deno_core`/`v8` pins never leak (rebuild-plan Phase 0).
Ported from the proven PoC reference (`runtime-next`) and made self-contained in
the monorepo (vendors load from this crate's local `dist/`).

## Binaries

- **`apploader`** (`src/bin/apploader.rs`) — the real module-loader runtime: the
  custom `JuneLoader` (two React graphs in one isolate via `june://vendor/*`
  resolution), the one transpile funnel (type-strip-keep-JSX + the React
  Compiler pre-pass), file-routed RSC + Flight, and the live-RSC push HMR loop.
- **`june-runtime`** (`src/main.rs`) — the bundled + V8-snapshot binary;
  `build.rs` bakes the `loadExtScript` bootstrap and the vendor module map into
  the snapshot (~12ms cold isolate boot vs ~123ms).

## Build chain

```sh
bun runtime/build.ts     # emits dist/* (server/ssr/vendor bundles the snapshot bakes)
cargo build --release    # produces target/release/{apploader,june-runtime}
```

`dist/` and `target/` are generated (gitignored); `bun build.ts` regenerates the
snapshot inputs `build.rs` reads.

## Status

The runtime renders its OWN ported file-routed RSC demo today. Bringing it under
the @junejs/core Phase-1 semantics — so `june dev` IS this binary and it passes the
golden `parity.test.ts` as a third renderer — is the convergence frontier.
The concrete plan: **[docs/runtime-convergence.md](../docs/runtime-convergence.md)**.
