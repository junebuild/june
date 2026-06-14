# juno-compile-once

Does an ergonomic, typed table API have to cost performance? This benches a
**compile-once** prototype (pay the abstraction once → cached prepared statement;
`.raw()` + a codegen'd monomorphic row mapper; named-param binding) against
hand-written raw `better-sqlite3` — the floor.

The prototype (`juno.mjs`) is a throwaway to bound the ceiling, **not** the
shipping `@junejs/juno` (which is async over the `JuneDb` contract). It proves the
design principle: *the idiomatic way to write a query can also be the fast way*.

## Run

```bash
npm install
node bench.mjs
```

In-memory DB, 10k-row `users` table, single-row hot loops.

## Last observed (Intel i9 x86_64 — ratios/shapes, not absolutes)

| operation | juno prototype vs raw floor |
|---|---|
| point select by id | ~97% |
| range select (many rows) | ~98% |
| single insert (named binding) | ~81% |

i.e. the ergonomic surface sits ~at the raw floor; the remaining insert gap is
named-bind overhead (object property lookup vs positional). See
`docs/juno-sqlite-performance.md` for the full synthesis.

> These are observed spike numbers, not registry-published figures. Canonical
> numbers belong in `../../results.json`, bound to this script.
