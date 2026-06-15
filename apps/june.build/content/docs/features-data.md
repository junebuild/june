---
title: "The data model"
nav: "Data model"
description: Resources are declared, not wired. db / kv / blob ride an ambient scope — never ctx, which is identity only. Bring Juno or your own.
date: 2026-06-13
section: Concepts
order: "13"
---
## Declared, not wired

Data is a declaration. Naming a resource in `june.config.ts` enables it — omit
it and it doesn't exist; an unused one compiles away. Each gets a zero-config
local default in `june dev` and a deploy binding on each target.

```ts
// june.config.ts
import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server/db";

export default defineJune({
  resources: {
    db: sqlite(), // dev: ./.june/dev.sqlite · deploy: D1 / Turso
  },
});
```

## `db` is ambient — never on `ctx`

You reach a resource with an **ambient** handle. There is no request object to
thread:

```ts
import { db } from "@junejs/db";

// the SAME import works in a loader, a view, a defineAction(), or a plain
// model file three calls deep — nothing to pass down.
const users = await db.query("select id, name from users order by id");
```

Keeping `db` off `ctx` is deliberate — it's the line that makes the whole model
coherent:

> **`ctx` is identity; `db` / `kv` / `blob` are capability.** `ctx` answers
> *who is calling* (user, session, url, params) — what authorization needs. The
> resources answer *what tools exist*. Mixing them onto one object forces every
> helper to thread `ctx` just to touch the database (the Express `req.db`
> anti-pattern). Instead the host runs each request inside a scope that holds
> the opened resources, and `db` / `kv` / `blob` read it through
> `AsyncLocalStorage` — so domain code never sees the request, and stays
> edge-safe (the async context loads lazily; nothing pulls a static `node:*`
> into the worker).

This is why an agent and a human run identical data code: there is no `ctx` to
thread or mock, and the authorization that matters lives in one place —
`run(input, ctx)` (see [Auth & the scoped principal](/docs/concept-auth)).

## Bring your own

The default layer is **Juno**, but the magic — auto-batched reads and
auto-invalidated cache (see [Queries & caching](/docs/features-queries-caching)) —
is a property of a small public *trace contract* (`recordTableRead` /
`recordTableWrite`), not of Juno:

- **Tier 1** — bring Prisma or Drizzle untouched.
- **Tier 2** — run them over the same connection to share config.
- **Tier 3** — add a thin shim that names the table read or written, and get the
  same auto-cache behavior.

## Why it matters

The data layer is the part of an app an agent writes most — and the part where a
threaded request object or a forgotten `revalidate()` does the most damage.
Making `db` ambient (nothing to thread) and invalidation automatic (nothing to
remember) removes both failure modes by construction, for humans and agents
alike.

> Status: **Changing** — the model above is settled; the query/resource surface
> is still being refined. See [Stability](/docs/05-stability).
