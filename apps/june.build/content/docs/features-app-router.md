---
title: "App Router: the filesystem is the route table"
nav: "App Router"
description: page.tsx is a route, [slug] is a param, (group) shapes the tree without the URL, _anything colocates — one matcher drives dev and the build.
date: 2026-06-12
section: Features
order: "6"
---
## The conventions

| entry | role |
| --- | --- |
| `page.tsx` / `index.tsx` | the route leaf — a `route()` definition |
| `layout.tsx` | wraps everything below this segment ([Layouts](/docs/features-layouts)) |
| `not-found.tsx` | the 404 page (app root today; per-segment is wired in the router, pipeline next) |
| `[slug]/` | dynamic segment → `ctx.params.slug` |
| `[[slug]]/` | optional segment — matches with the param set or absent |
| `[...path]/` | catch-all → `ctx.params.path` (joined string) |
| `[[...path]]/` | optional catch-all — also matches zero segments |
| `(group)/` | route group — shapes the filesystem, invisible in the URL |
| `_anything` | never a route — colocate components, tests, models freely |

Matching priority at each level is **exact static > `[param]` >
`[...catchAll]`**, with backtracking: a static directory that dead-ends
doesn't shadow a dynamic sibling.

## One matcher, no drift

The same matcher drives `june dev` (resolved per request from the
filesystem) and `june build` (frozen into the worker manifest) — so the
routes you see in dev are the routes that deploy, by construction rather
than by discipline. `june info` prints the resolved table at any moment.

This very site is the demo: `/docs/[slug]` and `/blog/[slug]` are dynamic
segments, the docs sidebar is a nested layout, and `_content.ts` /
`_sections.ts` sit colocated inside `app/` without ever becoming routes.

## Stated limits

`loading.tsx` and `error.tsx` are recognized by the matcher (each segment's
special files travel with the match) but not yet wired: loading needs
streamed Suspense, segment error boundaries are a later milestone — see
[RSC](/docs/features-rsc) for the same honesty about streaming.

## Why it matters

A route table you write by hand is a route table that drifts. Conventions a
human can't misread are also conventions a coding agent can't misread — the
filesystem is the one source both audiences already know how to navigate.
