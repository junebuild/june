---
title: "Deployment"
description: One portable core, one host seam, one adapter per target — Workers, Vercel, and Deno Deploy ship today on the same bundle.
date: 2026-06-15
section: Get started
order: "3"
---
## The design

June separates *what renders* from *where it runs*:

- **The framework core is portable.** Routes, projections, actions, the agent
  surface — all of it speaks Web standards (`Request` in, `Response` out) and
  assumes no runtime. It is the same code on every target; deployment never
  changes behavior.
- **The host seam is the only thing that varies.** Everything standards don't
  cover — binding a port, opening a database, serving a static asset — lives
  behind one small interface. A deploy target is an *implementation of that
  seam*, not a fork of the framework.

So adding a target means writing an adapter, and an adapter cannot diverge from
the framework: dev, self-hosted, and every edge target run the same render core
(our parity suite asserts it byte-for-byte).

## Targets

| target | adapter | how | status |
| --- | --- | --- | --- |
| **Cloudflare Workers** | `workers()` (default) | Rolldown bundle + frozen manifest → `wrangler` upload; D1/R2/KV bindings | shipped |
| **Vercel** | `vercel()` | Build Output API; a Node Function on Fluid compute (default) or `vercel({ runtime: "edge" })` | shipped, live |
| **Deno Deploy** | `deno({ org, app })` | same bundle as an `export default { fetch }` handler; assets served in-process | shipped, live |
| **Self-hosted (Bun / Node)** | the host layer | the same pipeline over `Bun.serve` / `node:http` | serving layer CI-tested on both; a production `june start` verb is roadmap |
| **Own Rust+V8 runtime** | — | the experimental flagship: V8-snapshot boot, un-bundled dev | experimental ([Runtime](/docs/features-runtime)) |

The deploy verb is fixed; the **target is one line of config**. Workers is the
default, so an app with no `deploy.adapter` ships to Workers.

```ts
// june.config.ts
import { defineJune } from "@junejs/core/config";
import { vercel } from "@junejs/server"; // or workers, deno

export default defineJune({
  deploy: { adapter: vercel() }, // omit entirely → workers()
});
```

## Per target

**Workers** — the default. `june build` emits `worker.js` + `wrangler.jsonc`;
`june deploy` runs `wrangler`. A declared `db` becomes a D1 binding and pending
migrations apply *before* the new worker ships (a destructive migration halts
the deploy until you re-run with `--allow-destructive`).

**Vercel** — `vercel()`. Defaults to a **Node Function on Fluid compute** (no
1–4 MB code cap, full API); pass `vercel({ runtime: "edge" })` for an Edge
Function where global latency matters. `june build` writes `.vercel/output/`
(Build Output API); `june deploy` runs `vercel deploy --prebuilt`. Data is
ambient — `import { db } from "@junejs/db"` over a Turso connection.

**Deno Deploy** — `deno({ org, app })`. The same portable bundle, wrapped as an
`export default { fetch }` handler; framework assets (`/_june/*`) are served
**in-process** from the bundle (Deno Deploy has no asset CDN binding). `june
deploy` runs `deno deploy`. Data is Turso (D1 is Cloudflare-only).

> First Deno deploy: provision the app in **dynamic** mode once, or Deno's
> framework auto-detection finds no entrypoint and the build fails with *"No
> runtime entrypoint provided"*:
>
> ```
> deno deploy create --org=<org> --app=<app> --source=local \
>   --do-not-use-detected-build-config --runtime-mode=dynamic --entrypoint=worker.js
> ```
>
> After that, plain `june deploy` ships every revision.

## `june deploy`

`june deploy` = build → resolve the target's config → upload → print the URL.
`--dry-run` validates everything *without* uploading — it's also the CI test, so
the deploy path is exercised on every push. `--prod` targets production (the
default is a preview deploy) on Vercel and Deno.

## Resources follow the same model

Declare `db` / `blob` / `kv` once; each target maps them to its native services:
D1 / R2 / KV on Workers, Turso (SQLite over HTTP) on Vercel and Deno, SQLite +
local disk in dev. The declaration is portable; the binding is the adapter's job.

## Why this shape

Deployment lock-in is usually accidental: the framework leaks its favorite
runtime's APIs until leaving costs a rewrite. June's rule — core speaks
standards, hosts implement one seam — makes the exit door part of the
architecture. The target you pick is a decision you can revisit.

## Honest notes

- Workers, Vercel, and Deno are deployable today; self-hosting serves the same
  pipeline but the `june start` production verb is still roadmap.
- The Node host actually *exceeds* the others in one spot — real RFC 8297
  `103 Early Hints` interim responses.
- Version 0.0.x: the adapters work, the API around them can still move.
