---
title: "Queries & caching"
nav: "Queries & cache"
description: How to read and write through the ambient db — the query surface, plain-SQL migrations, and the auto-batch / auto-invalidate cache.
date: 2026-06-15
section: Features
order: "30"
---
## Reading

Reach the database with the ambient `db` ([the data model](/docs/features-data)
explains *why* it's ambient and off `ctx`) and query it:

```ts
import { db } from "@junejs/db";

export const loader = async () => ({
  users: await db.query("select id, name from users order by id"),
});
```

The dev default is a plain file at `.june/dev.sqlite` that survives the dev
server's reload-on-save restarts — and the `sqlite3` already on your machine
opens it directly:

```bash
sqlite3 .june/dev.sqlite '.tables'
```

## Migrations — the SQL you read is the SQL that runs

A connected database does **not** invent tables. Schema lives in versioned SQL
you can read and diff:

```sql
-- db/migrations/0001_init.sql
create table users (id integer primary key, name text not null);
```

`june dev` applies pending migrations on startup — **safe, additive ones
automatically** (`create table`, `add column`, a new index). A **destructive**
change (`drop`, a narrowing `alter`) halts with the safe prefix already applied
and asks first; you run it deliberately with `june db migrate --allow-destructive`.
Add the next change as `0002_*.sql` — never edit an applied file. The same
ordered ledger runs at deploy against D1, so dev and production converge on one
schema.

## Caching — auto-tag, auto-invalidate, auto-batch

Reads and writes flow through a small public trace contract, which is all the
framework needs to make caching a consequence of the write, not a chore:

```ts
import { db } from "@junejs/db";

const listUsers = cache(() => db.table("users").all());   // tagged [table:users]
await invokeAction("createUser", { name: "Ada" });        // writes users →
await listUsers();                                        // cache MISS — fresh
```

- **auto-tag** — every `cache()` entry is tagged by the tables it read.
- **auto-invalidate** — a write to a table drops exactly those entries. No
  `revalidatePath`, no tags to remember, no manual `revalidate()` — ever.
- **auto-batch** — N component reads of the same query on one render collapse to
  a single round trip (measured: **8.8× fewer** D1 queries vs naive
  per-component reads — see [Benchmarks](/benchmarks)).

Stale-cache bugs are the classic failure of hand-wired `revalidate()` calls, and
agents forget them exactly as often as humans do. Making invalidation fall out
of the write removes the whole class.

## `kv` and `blob`

The other resources follow the same ambient shape — `memoryKv()` / `localBlob()`
in dev, `redisKv()` / `r2()` on deploy — reached as ambient `kv` and `blob`:

```ts
import { kv, blob } from "@junejs/db";

await kv.set("greeting", "hi");
await blob.put("avatar.png", bytes);
```

> Status: **Changing** — see [Stability](/docs/05-stability).
