# @junejs/juno

June's ergonomic data layer — a typed table API over the `JuneDb` contract, so it
runs over sqlite / D1 / Postgres alike. **Optional Tier 3:** a minimal app just uses
the raw `db` resource (`db.query(sql, params)`); declare Juno to get the magic
(auto-batch, auto-invalidation, compile-once). Depends on `@junejs/core` +
`@junejs/db` (inward); the framework never imports Juno.

## Use it

Opt in once, in `june.config.ts`:

```ts
import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server";
import { junoDataLayer } from "@junejs/juno";

export default defineJune({ resources: { db: sqlite() }, dataLayer: junoDataLayer() });
```

Then, ambiently — no handle to thread, `ctx` stays identity-only; use inside a
request (a loader/view/action):

```ts
import { table } from "@junejs/juno";
import { db } from "@junejs/server"; // the one canonical handle

await table("users").findBy({ email: "ada@x.dev" });         // point read (auto-batches)
await table("posts").all(
  { user_id: 7, created_at: { gte: cutoff }, title: { like: "%june%" } },
  { orderBy: { created_at: "desc" }, limit: 20, offset: 0 },
);
await table("users").upsert({ email: "ada@x.dev", name: "Ada" }, { onConflict: "email" });
await db.query("select * from users where age > ?", [18]);   // raw escape hatch (auto-tags)
```

## Non-obvious facts (the easy-to-get-wrong bits)

The API shape is self-explanatory; these are the things models and humans get
backwards. High-signal on purpose — read these, skip re-deriving the obvious.

- **Write the naive thing — the automatic layer makes it fast/correct.** Don't
  hand-roll caching or batching loops on top; that's what Juno is for.
- **`findBy` / `all` by a single column auto-batch per request.** Naive per-component
  reads coalesce into one `where col in (...)` — do NOT manually collect ids to batch.
- **Use `upsert(values, { onConflict })`** — atomic, one round trip, returns the row.
  NOT `findBy`-then-`insert` (an extra round trip and a race).
- **Auto-invalidation fires at the ACTION boundary, not on a write.** A mutation must
  be a `defineAction`; a direct `insert`/`update` outside an action invalidates no
  `cache()`. Don't expect a bare write to refresh a cached read.
- **On D1 / edge, round trips dominate — not the engine.** Auto-batch kills
  *sequential* N+1 (the catastrophe). Versus *concurrent* reads the win is modest —
  concurrency already hides latency. Never go sequential; don't over-credit
  batch-vs-concurrent.
- **OR and joins → the raw `db` escape hatch.** `all()` covers AND-of-operators
  (`eq/ne/gt/gte/lt/lte/in/like`) + order / limit / offset; raw SQL is first-class
  for the rest, and the canonical `db` auto-tags it (so a raw read inside `cache()`
  is invalidated by a write, not silently stale).

## Tiers (Juno is optional)

The framework works fully without Juno. **Tier 1** = bring your own (Prisma/Drizzle),
untouched. **Tier 2** = your ORM over the ambient `db` resource. **Tier 3** = Juno
(or any thin shim emitting `recordTableRead`/`recordTableWrite`) for the
auto-invalidate / auto-batch / live-RSC magic. See `docs/data-layer-boundary.md`.

For tests or bring-your-own wiring, the explicit handle still works:
`const j = juno(someDb); await j.table("users").all()`.
