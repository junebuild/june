---
title: Build & prerender
description: What june build freezes at build time, and how opt-in prerender ships exactly what was tested.
date: 2026-06-15
section: Get started
order: "2"
---
## `june build`

Everything dynamic about dev gets frozen at build time:

| input | output |
| --- | --- |
| `app/**/page.*` | static route manifest (+ nested layout chains) |
| `june.config.ts` | inlined literals (site, speculation, agent config) |
| `content/<dir>/*.md` | `app/_content.ts` — the manifest dev AND workerd read |
| a page exporting `prerender = true` | static html/md/json rendered THROUGH the built worker |
| `app/_client.*` | the islands bundle served at `/client.js` |

The bundle is self-contained ESM (rolldown; conditions baked in — workerd has
no runtime conditions). Binary assets and `build.external` packages stay
external for wrangler's own rules.

## Prerender

Opt-in per route, static routes only. What ships is what was tested: the
build renders through the bundled worker, not a parallel code path. Don't opt
in routes whose output depends on `ctx.url.origin`.

## Then deploy

The same bundle ships to any target — the verb is fixed, the target is one line
of config. `june deploy` = build → upload → URL, with `--dry-run` as the CI
test. See [Deployment](/docs/04-deployment) for the adapters (Workers, Vercel,
Deno) and what each maps your resources to.
