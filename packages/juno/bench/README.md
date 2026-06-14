# @junejs/juno benches

Workspace benches that exercise the real juno package. They live here (not under
`bench/scenarios/`) because they import `@junejs/server` / `@junejs/core`, which
resolve only via this package's `node_modules`. Run from the package:

```bash
cd packages/juno
bun bench/ambient-batch.ts
```

## ambient-batch.ts — ambient per-request `findBy` auto-batch

Proves the feature: scattered, no-loader `findBy({id})` across components collapses
into one `where id in (...)` query (the moat validated in
`docs/juno-positioning.md` Appendix 3).

Last observed (in-memory sqlite; ratios/shapes, not absolutes):

- **Query count** (the real D1 round-trip metric): K scattered `findBy` → **1 query**
  vs K naive per-component → **K queries** (10/30/100 → 1).
- **Wall-clock** (30 components, 5ms/RTT, D1-like concurrency cap 6): ambient ≈ 1
  round trip (~5ms) vs naive concurrent **~5×** slower (cap forces ~5 RTT waves) vs
  naive sequential **~30×** slower. At real D1 latency (~225ms/RTT) the ratios hold
  and absolute gaps scale ~45×.

> Observed spike numbers, not registry-published. Real remote-D1 ground truth is in
> `bench/scenarios/edge-d1-remote` (batch sweep ~81× at K=100).
