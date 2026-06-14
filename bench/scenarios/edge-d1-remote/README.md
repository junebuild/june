# edge-d1-remote

Benchmarks **real remote Cloudflare D1** from a deployed Worker — not the
`wrangler dev` local-miniflare D1 the frozen PoC used. Real cross-region latency
changes the conclusions: on D1 the only optimization axis is **round-trip count**,
not engine or ORM. All timings are server-side (Worker→D1), excluding
client→Worker latency.

## Run

```bash
npm install -D wrangler
wrangler d1 create juno-bench --location apac     # paste database_id into wrangler.jsonc
export CLOUDFLARE_ACCOUNT_ID=<account>
wrangler deploy                                    # real cross-region; or: wrangler dev --remote
BASE=https://juno-bench.<subdomain>.workers.dev
curl "$BASE/seed"                                  # 100k rows (idempotent)
curl "$BASE/bench?n=30"                            # per-query RTT
curl "$BASE/sweep?rep=2"                           # sequential vs DB.batch() sweep
curl "$BASE/render?k=30&rep=5"                     # render auto-batch vs concurrent
curl "$BASE/session?n=20"                          # Sessions API (needs read replication)
```

Read replication (for `/session`) is enabled per-DB, not via wrangler config:
`PATCH /accounts/{acct}/d1/database/{db}` body `{"read_replication":{"mode":"auto"}}`.
Smart Placement: add `"placement": { "mode": "smart" }` to wrangler.jsonc (needs
sustained traffic to relocate the Worker near the primary).

## Last observed (Worker ingress DFW, D1 primary APAC, 100k rows — shapes, not absolutes)

- **Per point query: ~225ms** (cross-Pacific RTT), ~4 ops/s. Local miniflare sim
  understates this ~275x.
- **Batch sweep — the lever** (sequential scales linearly; `DB.batch()` stays ~1 RTT):

  | batch B | sequential | batched | speedup |
  |---|---|---|---|
  | 10 | 2,254ms | 234ms | 9.6x |
  | 50 | 11,391ms | 251ms | 45x |
  | 100 | 22,557ms | 279ms | **81x** |

- **render auto-batch vs naive concurrent: 1.6x** at real latency (concurrency
  already hides RTT; the catastrophe is *sequential* N+1 = ~6.8s for 30 rows).
- **Read replication + Sessions API: ~19x on reads** (230ms→12ms) via a nearby
  replica. `first-unconstrained` = fully local; `first-primary`/bookmark =
  read-your-writes. Speedup appears ONLY through `withSession` — a plain
  `prepare()` read still hits primary.

→ juno's two D1 pillars (both framework-only, a library can't do them): auto-batch
the render wave into one `DB.batch()`, and route reads through a per-request
session. See `docs/juno-sqlite-performance.md`.

> Observed spike numbers, not registry-published, and condition-dependent (ingress
> colo, primary region). Canonical numbers belong in `../../results.json`.
