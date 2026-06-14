# sqlite-driver-libsql

How does libSQL compare as a local sqlite driver, and what does an async-first
client cost per call? Two things the frozen PoC didn't isolate:

1. `libsql` (sync, better-sqlite3-compatible native binding) vs `better-sqlite3`.
2. `@libsql/client` (async, remote-first protocol even over `file:`) — the
   per-call Promise/await tax.

## Run

```bash
npm install
node libsql.mjs
```

File-backed DB, WAL, 10k-row `users` table. (`.gitignore` the generated `*.db*`.)

## Last observed (Intel i9 x86_64 — ratios/shapes, not absolutes)

Point select, file WAL, relative to `better-sqlite3`:

| driver | point select | bulk 10k | notes |
|---|---|---|---|
| better-sqlite3 `.raw()` | 100% | 100% | baseline |
| libsql (sync) `.raw()` | ~41% | ~20% | same SQLite-fork engine, less-optimized JS binding |
| @libsql/client (async) | ~4% | — | ~25x slower than sync; remote-first protocol + Promise per call |

→ For pure local, libSQL is strictly slower; its value is embedded replicas /
edge / branching. The async tax is a warning: keep the hot path sync, and any
remote backend must batch. See `docs/juno-sqlite-performance.md`.

> Observed spike numbers, not registry-published. Canonical numbers belong in
> `../../results.json`, bound to this script.
