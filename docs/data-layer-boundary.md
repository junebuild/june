# Data layer boundary — the resource seam (Phase 5 design constraint)

> Decided 2026-06-11. June owns a thin data CONTRACT (resources + a trace
> contract), not an ORM. Juno is the flagship default implementation behind that
> contract; Prisma/Drizzle/raw SQL remain first-class. This doc is the binding
> constraint for Phase 5 so the boundary is right from commit #1.

> **Update (2026-06-14): the access model is now AMBIENT.** `db`/`kv`/`blob` are no
> longer injected onto `ctx` — `ctx` is IDENTITY only (user/session/url/params). The
> host runs each request inside a scope (`@junejs/db`'s AsyncLocalStorage) and the
> resources are ambient accessors: `import { db } from "@junejs/db"`, usable in any
> loader/view/model/action without threading the request object (the Express
> `req.db` anti-pattern). The boundary, the three tiers, and the inward dependency
> all still hold — only "injected on `RouteContext`" becomes "ambient via the request
> scope." Juno now sits on this seam: it depends on `@junejs/db`, exposes an ambient
> `table()` / `db`, and keeps its per-request batch loaders in the scope via
> `requestLocal` (structurally per-request, so they can't leak across requests).

## The principle

The framework depends on a **seam**, never on a query builder. Three layers,
dependency direction always inward:

```
  @junejs/core (pure)        knows NOTHING about data — only the abstract
        ▲                table-touch trace contract (recordTableRead/Write)
        │ depends on
  resource seam          db · blob · kv  — async contracts + binding model
        ▲                + the trace/invalidation contract
        │ implements
  Juno / Drizzle / Prisma / raw   ← swappable. Juno is the default; not load-bearing.
```

@junejs/core must stay `node:*`-free, so it never imports a driver. Resource handles
are **opened by the host** and made **ambient** for the request (read from an
AsyncLocalStorage scope, not injected on `ctx` — `ctx` is identity-only);
@junejs/core declares only the abstract type.

## Resources, not `openDb(path)`

`openDb(path)` was a Phase-2 local primitive and is NOT a standard (there is no
WinterTC standard for server data; the de-facto edge standard is the **binding**
model — declare in config, runtime injects a handle). The user-facing model is
declarative resources with generic names (NOT Cloudflare-branded), each with a
zero-config local default and a deploy adapter:

| Resource | Class | Local default (`june dev`) | Deploy adapters |
| --- | --- | --- | --- |
| `db` | relational / SQL | embedded SQLite file | **D1** · Postgres · libSQL |
| `blob` | object / file | `./.june/blob` dir | **R2** · S3 |
| `kv` | key-value / cache | in-memory | **KV** · Redis |

`kv` already exists — it is today's `cache.ts` (`CacheStore` seam). Phase 5
reframes cache as the `kv` resource rather than adding a new system.

```ts
// june.config.ts — declaring a resource enables it; omit it and it does not exist.
export default defineJune({
  resources: {
    db: d1("DB"),          // dev: embedded sqlite · deploy: D1 binding
    blob: r2("UPLOADS"),   // dev: ./.june/blob · deploy: R2
    // kv omitted → built-in memory cache (today's behavior)
  },
});
```

```ts
// Ambient: `import { db }` and use it anywhere — `ctx` is identity-only.
import { db } from "@junejs/db";
route({ load: async () => ({ posts: await db.query("select * from posts") }) });
```

## On by default, removable, and compiled away for static

Same philosophy as the agent surface (`resolveAgent`: defaults on, one master
switch off):

- **Zero-config default:** `june dev` just works — embedded SQLite + local blob
  dir + in-memory kv, no Docker, no setup.
- **Removable:** don't declare a resource → it is never instantiated.
- **Compiled away for static:** the build freeze (Phase 3) already scans which
  resources each route touches. No route touches `db` → it is tree-shaken out of
  the worker graph, no binding is emitted, and fully-`prerender` routes ship as
  assets with no worker at all. Same mechanism as reminder #4 — not a new feature.

## Bring your own ORM — Prisma / Drizzle stay first-class

The framework FUNCTIONS fully with Prisma/Drizzle; there is no point where "use
Juno or it breaks." There are three tiers the user picks freely:

**Tier 1 — BYO everything.** Import Prisma/Drizzle,
instantiate it yourself, use it in `load()`. June does not care. You keep full
data flexibility. What you DON'T get automatically: cache auto-invalidation,
auto-batch, mutation→live-RSC — because June cannot see your reads/writes.

```ts
import { drizzle } from "drizzle-orm/...";
const db = drizzle(process.env.DATABASE_URL!);
route({ load: () => db.select().from(posts) }); // works, plain
```

**Tier 2 — your ORM over June's `db` resource.** The ambient `db` hands you the
raw async connection / D1 binding; wrap it with Drizzle (`drizzle(db)`). Now you
share one config surface (D1/Postgres declared once), the wrangler binding, and the
zero-config local SQLite — but the query API is Drizzle. Drizzle is a
driver-over-builder, so the ambient `db` is a natural target; Prisma works too via
its driver adapters (e.g. the D1 adapter).

**Tier 3 — full magic, opt-in.** The agent-native magic (auto-invalidation /
auto-batch / live-RSC) is a property of emitting the trace signals
`recordTableRead` / `recordTableWrite`, NOT of using Juno. Juno emits them
natively; for Drizzle/Prisma it is a thin shim (a query hook / logger that names
the table). June can ship `@junejs/drizzle` doing exactly this, or the community
can — the contract is public.

So: **Tier 1 = bring your own, untouched. Tier 2 = shared infra. Tier 3 =
the differentiator, opt-in.** Juno is just the implementation that ships at
Tier 3 out of the box.

## Juno's place

Juno is the ergonomic layer over the `db` resource (SQL-shaped typed builder,
SQL-as-truth migrations + semantic overlay, every-surface-an-oracle — see
data-philosophy.md). It is a SEPARATE package (`@junejs/juno`) on the resource seam
(depends on `@junejs/core` + `@junejs/db`, inward). It mirrors the ambient model
(`import { table } from "@junejs/juno"`) and keeps its per-request batch loaders in
the request scope via `requestLocal`, so batching is structurally per-request and
unstashable. There is ONE canonical `db` (from `@junejs/db`, re-exported by
`@junejs/server`); it is always usable without Juno, and importing Juno upgrades it
in place to auto-tag raw queries (Juno registers a tagger; the framework never
imports Juno).

## Phase 5 constraints (do these from commit #1)

1. Demote Phase-2 `openDb(path)` to an internal host primitive (the local SQLite
   driver); expose data as config-declared resources made **ambient** for the
   request (read from the request scope), not injected on `ctx`.
2. Reframe `cache.ts` as the `kv` resource (it already is one).
3. Add the `blob` seam (local-dir default + R2/S3 adapters).
4. `db`'s D1 adapter is the third `openDb` impl (rebuild-plan Phase 5).
5. Juno is its own package on top of `db`; dependency direction always inward;
   the trace contract (`recordTableRead/Write`) stays public so any ORM can reach
   Tier 3. @junejs/core never imports a driver.
