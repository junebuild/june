# @junejs/juno

June's ergonomic data layer — a typed table API over the pure `JuneDb` contract
(`@junejs/core/resources`), so it runs over sqlite / D1 / Postgres alike. Juno sits
on the resource seam: it depends on `@junejs/core` and `@junejs/db` (inward); the
framework never imports Juno.

```ts
import { table, db } from "@junejs/juno";

// Ambient — matches June's resource model (`import { db } from "@junejs/db"`).
// No handle to thread; `ctx` stays identity-only. Use inside a request scope
// (a loader/view/action). The batch-loader registry lives in the request scope,
// so batching is structurally per-request and unstashable.
await table("users").all();
await table("users").all({ org_id: 7 });           // filtered list
await table("users").findBy({ email: "ada@x.dev" }); // concurrent calls auto-batch
await table("users").insert({ name: "Ada" });
await table("users").upsert({ email: "ada@x.dev", name: "Ada" }, { onConflict: "email" });

// `db` is the raw escape hatch, auto-tagging: a raw read inside cache() is still
// invalidated by a write (vs the un-tagged `@junejs/db` `db`).
await db.query("select * from users where age > ?", [18]);
```

For tests or bring-your-own wiring, the explicit handle still works:
`const j = juno(someDb); await j.table("users").all();`.

## The magic is opt-in, not load-bearing

Juno is the **default** that ships at Tier 3: every read calls `recordTableRead`
and every write `recordTableWrite` (@junejs/core's public trace contract). That is
what makes `cache()` auto-tag by table and a mutation **auto-invalidate** the
cache (and push live RSC) with zero manual `revalidate()` — including raw queries
through `db` (it parses the table) and writes routed through actions.

This is a property of emitting the trace signals, **not** of using Juno. The
framework depends on the contract, never on Juno — so Prisma/Drizzle stay
first-class (Tier 1 = bring your own, untouched; Tier 2 = your ORM over the ambient
`db` resource; Tier 3 = the same magic via a thin shim). See
`docs/data-layer-boundary.md`.
