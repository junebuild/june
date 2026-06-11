# Auth integration — Better Auth, blessed and zero-glue (v0.1 constraint)

> Decided 2026-06-11. June does NOT build auth. It blesses **Better Auth** as the
> opinionated default and integrates it so well there is no adapter glue — and
> bridges its identity into the agent surface. Same philosophy as the data layer:
> opinionated default + open seam. See docs/data-layer-boundary.md.

## Principle

"Opinionated" ≠ "build it ourselves." It means *pick the winner and integrate it
until there is no glue*. Auth is security-critical and a moving target, so the
primitives (providers, sessions, password, 2FA, account linking) stay with the
specialist — Better Auth. June owns the **integration seam** and the **agent
bridge**, nothing more. That keeps June off the hook for auth CVEs while still
delivering the differentiator.

Better Auth is a natural fit: its handler is **Web-standard fetch-shaped**
(`Request → Response`) and it is database-adapter based — exactly June's pipeline
and resource model. (Contrast the MCP SDK's `node:http` coupling June had to
route around — Better Auth points the other way.)

## What June integrates (the glue it removes)

1. **Better-Auth-on-`JuneDb` adapter.** Better Auth stores users/sessions/
   accounts/verification. Instead of `betterAuth({ database: prismaAdapter(...) })`
   plus a runtime adapter, June ships an adapter that targets the `db` RESOURCE
   (`JuneDb`). Declare `resources.db` once; Better Auth uses it. The
   ORM × runtime × auth-adapter matrix collapses to "Better Auth on June's db".
2. **Schema → migrations.** Better Auth's required tables are generated into
   June's SQL-as-truth migrations, so `june` (and an agent reading the schema)
   sees them — not a disconnected `betterauth generate`.
3. **Handler auto-mounted.** Better Auth's fetch handler is mounted at a
   conventional path (`/api/auth/*`) by the pipeline — zero config, no node
   coupling.
4. **Session injected onto RouteContext.** June resolves the session per request
   and injects `ctx.user` / `ctx.session` through the SAME path as db/kv/blob.
   `load()` and action `run()` see `ctx.user` with zero wiring.
5. **The agent bridge (the wedge).** The same session flows into the MCP/action
   layer: an agent calling `/mcp` `tools/call` carries the user's credential
   (Better Auth bearer / API key), June resolves it to the **same `ctx.user`**,
   and `defineAction` authorization sees a **scoped principal**. One
   authorization model for the UI and the agent — powered by Better Auth, not
   reimplemented. No Next + Better Auth setup gives this, because Next has no
   unified agent surface for the identity to flow into; June owns it, so the
   bridge is free.
6. **Discovery declares auth.** llms.txt / the MCP server-card advertise not just
   *which* tools exist but *what scope each needs and how an agent
   authenticates* — agent-*ready* auth.

## Design implication: `defineAction` gains a principal

Today `defineAction.run(input)` takes only the input. Point 5 requires the action
to see *who* is calling, so the same authorization runs on the UI and agent
paths. The signature becomes:

```ts
defineAction({
  id: "deletePost",
  input: { /* json schema */ },
  run: async ({ id }, ctx) => {        // ctx carries the scoped principal
    if (!ctx.user) throw new Unauthorized();
    await juno(ctx.db).table("posts").delete({ id, ownerId: ctx.user.id });
  },
});
```

This is a v0.1 change to the action core (it touches both the UI server-action
dispatch and the `/mcp` `invokeAction` path), so it must be designed before the
action signature ossifies.

## App-facing shape

```ts
// june.config.ts — declare once, glue gone
export default defineJune({
  resources: { db: d1("DB") },            // sqlite() in dev
  auth: betterAuth({                       // standard Better Auth config
    emailAndPassword: { enabled: true },
    socialProviders: { github: { /* … */ } },
  }),
  // June wires: Better Auth → resources.db, mounts /api/auth/*, schema →
  // migrations, injects ctx.user / ctx.session, bridges identity into /mcp.
});
```

## Seam consistency + the honest caveat

Auth is "opinionated default (Better Auth) + open seam", exactly like data
(Juno default, Drizzle/Prisma first-class). The deepest, zero-glue path is
coupled to Better Auth's trajectory — a deliberate bet on a fetch-shaped,
framework-agnostic, ascendant library. The seam stays open: another auth library
can target the same `db`/`kv` resources; it just doesn't get the blessed
integration. junecore never imports an auth library — the bridge reads an
abstract principal off `ctx`, the host (the Better Auth integration package,
e.g. `@junejs/auth`) populates it.

## Why this delivers "agent-ready apps with ease"

- **ease** = declare resources once → Better Auth auto-wired → session in `ctx`.
- **agent-ready** = auth-aware MCP/discovery + the scoped-principal bridge.

Both come from the integration, not from new primitives — which is exactly what
an opinionated framework should be, and it lets June ship the differentiator
without owning auth's security surface.
