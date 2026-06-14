# Juno local-SQLite performance

R&D notes behind Juno's local-SQLite driver selection and its optimization
roadmap. Juno (`packages/juno`) is an **async** table API over the `JuneDb`
contract (`packages/core/src/resources.ts`), so it runs over local sqlite, D1,
and Postgres alike. The local sqlite path is selected and adapted in
`packages/june/src/sqlite-driver.ts`. This doc records what the engine floor
actually is, which knobs matter, and where our current adapter leaves
performance on the table.

**Scope:** this doc is about the **local** sqlite path. Edge/D1 performance is a
different axis entirely — there the per-query RPC boundary (~sub-ms to ms)
dominates and engine/binding micro-optimization is noise; the lever is collapsing
round trips (batching, render-level auto-batch). That work has its own prior
benchmarks under `experiments/orm-bench/` and the registry entry "render-level
auto-batch on Cloudflare D1" in `bench/results.json`. Edge/D1 is tracked
separately, not in this doc.

**Provenance:** the numbers below are from an independent throwaway spike (Intel
i9 x86_64, file-backed DB, 10k-row `users` table, single-row hot loops unless
noted), run fresh to validate the design — they are *ratios and shapes*, not
registry-published figures. Authoritative, re-runnable numbers live in
`bench/results.json` (each bound to a script); do not hand-copy these into any
site page. **Caveat:** these are
micro-benchmarks where per-call and marshaling overhead dominate; for
disk-IO-bound queries or huge result sets the engine itself dominates and the
relative gaps shrink. Treat them as ceilings on *overhead*, not predictions of
app throughput.

## The engine is the floor — and a native binding already reaches it

To know whether the host language costs us anything, we compared a hand-written
Rust `rusqlite` build (thin binding straight onto the SQLite C API, release +
LTO) against the JS bindings, same DB / WAL / methodology.

Point SELECT by id (raw column access → struct/object), file WAL:

| binding | ops/s | rel |
|---|---|---|
| better-sqlite3 `.raw()` | 377,906 | 100% |
| rusqlite `query_row` → struct | 365,968 | 97% |
| node:sqlite `setReturnArrays` | 304,811 | 81% |

Single-row insert (autocommit, fsync-bound): rusqlite ≈ better-sqlite3 ≈
node:sqlite — all within noise, because the WAL fsync policy dominates, not the
binding.

Bulk SELECT all 10k rows → array of objects / `Vec<User>` (marshaling-heavy —
the case that should favor native most):

| impl | rows/s | rel |
|---|---|---|
| rusqlite `query_map` | 2,950,495 | 100% |
| better-sqlite3 `.raw()` + codegen map | 2,690,421 | 91% |
| better-sqlite3 `.all()` object-mode | 1,579,346 | 54% |
| node:sqlite arrays + map | 1,441,201 | 49% |

**Conclusion: the SQLite C engine is the floor, and `better-sqlite3` already sits
on it.** A native rewrite buys ~0% on point reads and inserts, and at most ~10%
on the hottest bulk-marshaling path. There is no performance reason to leave the
JS ecosystem for a native core. If we ever ship a native artifact, the reason
will be packaging (single binary, no node-gyp), never speed.

## The three knobs that actually move the needle

### 1. WAL — the single biggest write knob (and it's free, and ours)

`journal_mode` is pure PRAGMA, fully under our control. It is a **no-op on
`:memory:`** (stays `memory`); it only takes effect on a file DB. Same binding,
WAL vs the default rollback journal, `synchronous=NORMAL`:

| | WAL | rollback (DELETE) | WAL speedup |
|---|---|---|---|
| insert (autocommit) | 32.6k/s | 1.47k/s | **~22x** |
| point select | 378k/s | 125k/s | ~3x |

→ Local file DBs should default to `journal_mode=WAL; synchronous=NORMAL`.

### 2. `.raw()` + a codegen'd row mapper

Returning rows as positional arrays (`better-sqlite3` `.raw()`, `node:sqlite`
`setReturnArrays`) and hydrating them with a generated monomorphic mapper
(`new Function` building `{ id: r[0], ... }`) is what closes the bulk-read gap to
native: object-mode is only 54% of rusqlite; raw + map is 91% — a ~1.7x win on
bulk reads, for free.

### 3. Compile the query *shape* once

The dominant avoidable cost in any ergonomic data layer is rebuilding the SQL
string and re-preparing the statement on every call. The fix is to pay the
abstraction (typed columns, query shape) **once** at compile time and cache the
prepared statement, so the hot path is just bind → execute → map. A small spike
of this approach (compile-once + `.raw()` + named binding) over `better-sqlite3`
reached:

| operation | % of hand-written raw `better-sqlite3` |
|---|---|
| point select by id | 97% |
| range select (many rows) | 98% |
| single insert (named binding) | 81% |

i.e. the ergonomic surface can be ~at the raw floor. The design principle: **the
idiomatic way to write a query should also be the fast way** — no opt-in
"prepared mode" the caller (or an LLM generating code) has to know about.

### Bonus knob: async has a per-call tax — keep the hot path sync, batch the rest

Juno's surface is async because D1/remote require it. That's correct, but async
is not free per call. A remote-shaped client awaited once per query measured
**~25x slower** than the same engine called synchronously (≈14.5k vs ≈361k
ops/s) — Promise + microtask + protocol overhead on every row-sized call.
Implication: the local driver work must stay synchronous under the async surface
(it already is — see below), and any genuinely remote backend must **batch**.
Juno's per-request `loader()` (N+1 → one `where key in (...)`) is exactly this
discipline.

## Driver landscape (local, file WAL, point select relative to better-sqlite3)

```
better-sqlite3   100%   fastest; mature; richest API (.raw, custom fns). Native module (node-gyp/prebuild).
rusqlite          97%   native floor; no reason to adopt over bs3 for a JS project.
node:sqlite       81%   built-in, zero-install, no compile. Experimental (warns, API churn); Node >= 22.13 / 23.4.
bun:sqlite        ~57%* built-in under Bun only; strong on bulk .all()/.values(), weaker on single-row.
libsql (sync)     41%   same SQLite-fork engine, less-optimized JS binding. Adopt only for Turso/edge sync.
libsql (async)     4%   remote-first client; brutal per-call tax locally. Remote use only, always batched.
```

\* bun:sqlite single-row `.get()` object-mode, cross-runtime — indicative, not
exact. libSQL's value is embedded replicas / edge / branching, **not** local
speed; for pure local it is strictly slower.

## How this maps to our code (the roadmap)

Today the local adapter (`asyncSqlite` in `packages/june/src/sqlite-driver.ts`)
keeps the surface async over synchronous driver work — the right shape — but
leaves the three knobs above unclaimed. Prioritized:

1. **Set WAL on open (biggest, cheapest win).** `openLocalSqlite()` does not set
   `journal_mode`/`synchronous`. Add `PRAGMA journal_mode=WAL;
   PRAGMA synchronous=NORMAL` for file DBs (skip for `:memory:`, where WAL is a
   no-op). ~22x on writes, ~3x on point reads — for two lines.
2. **Cache prepared statements by SQL string.** The Node path adapts as
   `query: (sql) => db.prepare(sql)`, so it **re-prepares on every call**
   (parse + compile bytecode each time). `bun:sqlite`'s `db.query()` already
   memoizes — so the two runtimes are asymmetric today. Add a `Map<sql, stmt>`
   in the adapter to make the Node path match.
3. **Offer a raw + mapper path for reads.** `query()`/`get()` use object mode.
   A `.raw()` + codegen mapper variant recovers ~1.7x on bulk reads. This is an
   adapter-level concern; Juno stays unaware.
4. **Make Juno emit cache-friendly SQL.** `packages/juno/src/index.ts` builds
   SQL per call with `select *`. Emitting an explicit, stable column list keeps
   the per-shape SQL string identical across calls, so the adapter's
   statement cache hits. (Identifier safety is already handled by `ident()`;
   values are always bound `?` — injection-safe by construction.)
5. **Add `better-sqlite3` as an opt-in "fast local" adapter.** Keep
   `node:sqlite`/`bun:sqlite` as the zero-install default (the right call for a
   framework — no native build to fail on first run); let perf-sensitive local
   deployments opt into `better-sqlite3` behind the same `JuneDb` seam.

Because every optimization above lives in the driver adapter or the SQL Juno
emits — never in the engine — they are driver-independent and compose with the
`JuneDb` contract unchanged.

## What this does NOT prove

- Micro-bench only; disk-IO-bound and large-result workloads shrink the gaps.
- No joins / transactions-under-load / migration cost measured here.
- Single machine (Intel x86_64). Apple Silicon and Linux server profiles may
  reorder the middle of the driver table (esp. bun:sqlite).
- The compile-once numbers come from a throwaway spike, not Juno itself; they
  bound what's achievable, they don't describe current Juno.
