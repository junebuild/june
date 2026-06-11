# runtime/ — the native June runtime (Phase 4)

A standalone Cargo workspace, deliberately isolated from any other crate graph
so its `deno_core` / `v8` version pins never leak (rebuild-plan Phase 0).

**Status:** placeholder. Real work is Phase 4 — the only phase with genuine
unknowns; everything before it is porting.

**Reference implementation (frozen PoC):** `runtime-next/` in the PoC repo —
deno_core 0.403 + real WHATWG fetch, V8 snapshot (~12ms cold vs ~123ms),
the two-React-graphs-in-one-isolate `JuneLoader`, `june://vendor/*` snapshot
module map, one transpile funnel with the React Compiler pre-pass, and the
live-RSC push HMR loop. ~2.8k lines of Rust, working binary.

**Convergence target:** `june dev` IS this native binary; the Bun dev server
(Phase 2) demotes to a fallback. The same Phase-1 contract layer (`junecore`)
defines the semantics both runtimes serve.
