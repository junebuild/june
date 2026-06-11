# @junejs/juno

June's ergonomic data layer — a typed table API over the pure `JuneDb` contract
(`junecore/resources`), so it runs over sqlite / D1 / Postgres alike. Juno
depends only on `junecore` (inward); `junecore` never imports Juno.

```ts
import { juno } from "@junejs/juno";

const db = juno(ctx.db); // ctx.db is the injected `db` resource
await db.table("users").all();
await db.table("users").findBy({ email: "ada@x.dev" });
await db.table("users").insert({ name: "Ada" });
await db.table("users").update({ id: 1 }, { name: "Ada Lovelace" });
```

## The magic is opt-in, not load-bearing

Juno is the **default** that ships at Tier 3: every read calls `recordTableRead`
and every write `recordTableWrite` (junecore's public trace contract). That is
what makes `cache()` auto-tag by table and a mutation **auto-invalidate** the
cache (and push live RSC) with zero manual `revalidate()`.

This is a property of emitting the trace signals, **not** of using Juno. The
framework depends on the contract, never on Juno — so Prisma/Drizzle stay
first-class (Tier 1 = Next.js parity; Tier 2 = your ORM over `ctx.db`; Tier 3 =
the same magic via a thin shim). See `docs/data-layer-boundary.md`.
