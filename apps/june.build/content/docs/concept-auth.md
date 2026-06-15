---
title: "Auth & the scoped principal"
nav: "Auth"
description: One authorization gate for both audiences — run(input, ctx). ctx is the principal; an agent at /mcp is just another caller through the same gate.
date: 2026-06-15
section: Concepts
order: "15"
---
## One gate, both audiences

June has exactly one authorization gate, and both your UI and an agent pass
through it: a `defineAction()`'s `run(input, ctx)`.

```ts
export const deletePost = defineAction({
  id: "deletePost",
  input: { id: "string" },
  run: async (input, ctx) => {
    const post = await db.posts.find(input.id);
    if (post.authorId !== ctx.user?.id) throw new Error("forbidden");
    return db.posts.delete(input.id);
  },
});
```

There is no "expose to agents" step and no second permission system. The action
is a server action *and* an MCP tool; the check you write once protects both.

## `ctx` is the principal

`ctx` answers **who is calling** — `ctx.user`, `ctx.session`, and the request
(`url`, `params`). That is identity, and identity is *all* `ctx` carries: data
lives on the ambient `db` instead (see [the data model](/docs/features-data)), so
the only reason to reach for `ctx` is authorization.

## An agent is just another caller

When an agent calls a tool at `/mcp`, it carries the caller's credential, so the
SAME `run(input, ctx)` sees the SAME `ctx` it would for a UI request — and runs
the SAME check. The agent is a **scoped principal**: it can do exactly what that
user can do, no more. Nothing is re-declared; no tool gets a parallel ACL.

```
UI button ─┐
           ├─ run(input, ctx)   ← one gate, one ctx, one check
agent /mcp ─┘
```

## Better Auth by default

Authentication itself — sessions, providers, the login flow — is **Better
Auth**, June's blessed default. A first-class integration (wiring a Better Auth
session straight into `ctx` as the principal, and into `/mcp` scoping) is
**coming soon**. Until then you can wire it by hand, and **bring-your-own auth
works today** — June only needs you to populate `ctx.user` / `ctx.session`; the
gate doesn't care who issued the session.

## Why it matters

The expensive bug in an agent-ready app is an authorization gap between *what the
UI enforces* and *what the tool endpoint allows*. June closes it by
construction: there is only one gate, so there is nothing to keep in sync.

> Status: **Changing** — the model (one gate, `ctx`-as-principal) is settled; the
> Better Auth integration is in progress. See [Stability](/docs/05-stability).
