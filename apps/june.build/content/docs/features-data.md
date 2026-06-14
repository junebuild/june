---
title: "Data: ambient db + cache magic"
nav: "Data magic"
description: Declare db/kv/blob once and reach them with `import { db } from "@junejs/db"` — no request object threaded; a write auto-invalidates cached reads and N reads auto-batch.
date: 2026-06-13
section: Features
order: "10"
---
## The feature

Data is declared, not wired. Declaring a resource in `june.config.ts` enables
it — omit it and it doesn't exist. Each gets a zero-config local default in
`june dev` and a deploy binding on Workers:

```ts
// june.config.ts
import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server/db";

export default defineJune({
  resources: {
    db: sqlite(), // dev: ./.june/dev.sqlite · deploy: D1
  },
});
```

You reach it from anywhere with an **ambient** handle — there is no request
object to thread:

```ts
import { db } from "@junejs/db";

export const loader = async () => ({
  users: await db.query("select id, name from users order by id"),
});
```

That same `import` works unchanged in a loader, a view, a `defineAction()`, or a
plain model file three calls deep. Keeping `db` off `ctx` is deliberate:

> **`ctx` is identity; `db`/`kv`/`blob` are capability.** `ctx` answers *who is
> calling* (user, session, url, params) — what authorization needs. The
> resources answer *what tools exist*. Mixing them onto one object forces every
> helper to thread `ctx` just to touch the database (the Express `req.db`
> anti-pattern). Instead the host runs each request inside a scope that holds
> the opened resources, and `db`/`kv`/`blob` read it through
> `AsyncLocalStorage` — so domain code never sees the request. It stays
> edge-safe: the async context is loaded lazily, so nothing pulls a static
> `node:*` into the worker.

The dev default is a plain file (`.june/dev.sqlite`) that survives the dev
server's reload-on-save restarts — and the `sqlite3` already on your machine
opens it directly:

```bash
sqlite3 .june/dev.sqlite '.tables'
```

`kv` and `blob` follow the same shape — `memoryKv()` / `localBlob()` in dev,
`redisKv()` / `r2()` on deploy — reached as ambient `kv` and `blob`.

## Schema is explicit (migrations)

A connected database does **not** invent tables for you. Schema lives in
versioned SQL you can read and diff:

```sql
-- db/migrations/0001_init.sql
create table users (id integer primary key, name text not null);
```

`june dev` applies pending migrations on startup — **safe, additive ones
automatically** (`create table`, `add column`, a new index). A **destructive**
change (`drop`, a narrowing `alter`, …) halts with the safe prefix already
applied and asks first; you run it deliberately with
`june db migrate --allow-destructive`. Add the next change as
`db/migrations/0002_*.sql` — never edit an applied file. The same ordered ledger
runs at deploy against D1, so dev and production converge on one schema.

## The magic

Reads and writes go through Juno (the default data layer), which emits a public
trace contract — `recordTableRead` / `recordTableWrite`. That is all the
framework needs to:

- **auto-tag** every `cache()` entry by the tables it read,
- **auto-invalidate** those entries when an action writes the table — no manual
  `revalidate()`, ever,
- **auto-batch** N component reads of the same query into one.

```ts
import { db } from "@junejs/db";

const listUsers = cache(() => db.table("users").all());   // tagged [table:users]
await invokeAction("createUser", { name: "Ada" });        // writes users →
await listUsers();                                        // cache MISS — fresh data
```

The magic is a property of the *trace contract*, not of Juno: bring Prisma or
Drizzle untouched (Tier 1), run them over the same connection to share config
(Tier 2), or add a thin shim that names the table and get the same magic
(Tier 3).

## Why it matters

Stale-cache bugs are the classic failure mode of hand-wired `revalidate()`
calls — and agents writing code forget them exactly as often as humans do.
Making invalidation a consequence of the write removes the class of bug. And
because `db` rides an ambient scope rather than `ctx`, the code an agent writes
to read or write data is identical in a route and in a helper — nothing to
thread, nothing to mock.
