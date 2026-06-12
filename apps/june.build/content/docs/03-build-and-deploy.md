---
title: Build & deploy
description: What june build generates, how prerender works, and the deploy adapters.
date: 2026-06-12
---
## `june build`

Everything dynamic about dev gets frozen at build time:

| input | output |
| --- | --- |
| `app/**/page.*` | static route manifest (+ nested layout chains) |
| `june.config.ts` | inlined literals (site, speculation, agent config) |
| `content/<dir>/*.md` | `app/_content.ts` — the manifest dev AND workerd read |
| `route({ prerender: true })` | static html/md/json rendered THROUGH the built worker |
| `app/_client.*` | the islands bundle served at `/client.js` |

The bundle is self-contained ESM (rolldown; conditions baked in — workerd has
no runtime conditions). Binary assets and `build.external` packages stay
external for wrangler's own rules.

## Prerender

Opt-in per route, static routes only. What ships is what was tested: the
build renders through the bundled worker, not a parallel code path. Don't opt
in routes whose output depends on `ctx.url.origin`.

## `june deploy`

The verb is fixed; the target is an adapter — `workers` today, more later.
`june deploy` = build → resolve wrangler config → upload → URL.
`--dry-run` validates everything without uploading — it's also the CI test.
