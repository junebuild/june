---
title: "Data: resources + cache magic"
nav: "Data magic"
description: Declare db/kv/blob once; a write auto-invalidates cached reads and N component reads auto-batch — zero manual revalidate().
date: 2026-06-12
section: Features
order: "9"
---
## The feature

Data is declared, not wired. A resource gets a zero-config local default in
`june dev` and a deploy adapter on Workers:

```ts
// june.config.ts — declaring a resource enables it; omit it and it doesn't exist.
export default defineJune({
  resources: {
    db: d1("DB"),        // dev: embedded SQLite · deploy: D1
    blob: r2("UPLOADS"), // dev: ./.june/blob   · deploy: R2
  },
});
```

```ts
route({ load: async (ctx) => ({ posts: await ctx.db.query("select * from posts") }) });
```

## The magic

Reads and writes through Juno (the default data layer) emit a public trace
contract — `recordTableRead` / `recordTableWrite`. That is all the framework
needs to:

- **auto-tag** every `cache()` entry by the tables it read,
- **auto-invalidate** those entries when an action writes the table —
  no manual `revalidate()`, ever,
- **auto-batch** N component reads of the same query into one.

```ts
const listUsers = cache(() => db.table("users").all());   // tagged [table:users]
await invokeAction("createUser", { name: "Ada" });        // writes users →
await listUsers();                                        // cache MISS — fresh data
```

The magic is a property of the *trace contract*, not of Juno: bring Prisma or
Drizzle untouched (Tier 1), run them over `ctx.db` to share config (Tier 2),
or add a thin shim that names the table and get the same magic (Tier 3).

## Why it matters

Stale-cache bugs are the classic failure mode of hand-wired `revalidate()`
calls — and agents writing code forget them exactly as often as humans do.
Making invalidation a consequence of the write removes the class of bug.
