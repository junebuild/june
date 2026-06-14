# bench/scenarios

Re-runnable benchmark scenarios for June's data layer (juno). Each dir is
self-contained (its own `package.json` / `wrangler.jsonc`, a `README.md` with how
to run + last observed numbers). Published, canonical numbers live in
`../results.json` (the named-run registry) bound to a script + date — **do not
hand-copy a scenario's observed numbers into any site page**; re-run and let the
registry update.

## Scenarios here (the ones not already covered by the frozen PoC)

| dir | what it measures | why it's here |
|---|---|---|
| `juno-compile-once/` | juno's compile-once table API vs hand-written raw `better-sqlite3` (the floor): point / range / insert | validates the product thesis — the ergonomic surface stays at the raw floor |
| `sqlite-driver-libsql/` | `libsql` sync binding vs `@libsql/client` async, vs `better-sqlite3` | the async per-call tax + the sync libSQL binding gap (not in the PoC) |
| `edge-d1-remote/` | **real remote Cloudflare D1** (deployed Worker): per-query RTT, batch-size sweep, render auto-batch, Sessions API read replication | the PoC only had a `wrangler dev` local-miniflare D1; real cross-region latency changes the conclusions |

## Workspace benches (live with their package, not here)

Benches that import the real `@junejs/*` packages can't sit under `bench/scenarios/`
(those modules resolve only via a package's own `node_modules`). They live next to
the package:

- `packages/juno/bench/ambient-batch.ts` — ambient per-request `findBy` auto-batch:
  K scattered no-loader `findBy` collapse to 1 query (see `packages/juno/bench/README.md`).

## Not ported (still in the frozen PoC `../../../experiments/orm-bench/`)

The broader local-driver suite — `better-sqlite3` / `node:sqlite` / `bun:sqlite` /
`rusqlite` / WASM, Postgres (js / rust / pipelined), Go — lives there with its
own README. The local-sqlite findings were independently re-validated this round;
see `docs/juno-sqlite-performance.md` for the synthesis.
