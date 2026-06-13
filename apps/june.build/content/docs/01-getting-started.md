---
title: Getting started
description: Scaffold, develop, build, and deploy a June app in four commands.
date: 2026-06-12
---
## Install

```bash
npm create june my-app          # canonical (package: create-june)
cd my-app && npm run dev
```

The framework packages are `@junejs/core` (the contract layer: the page module, `defineAction()`,
islands) and `@junejs/cli` (the `june` command) — NOT `june`
(an unrelated npm package), not `junejs`, and not `@june/*` (that scope isn't
ours).

## The loop

```bash
june dev          # dev server (Bun/Node host)
june build        # Workers bundle: dist/worker.js + prerendered assets
june deploy       # build + wrangler upload (--dry-run validates only)
june gen          # freeze content/**/*.md → app/_content.ts
june info         # show routes + the agent surface
```

`june build` freezes what the dev server discovers at request time: routes →
a static manifest, `june.config.ts` → literals, `content/**/*.md` →
`app/_content.ts`, pages exporting `prerender = true` → static files.

## Where things go

```
app/            file-system routes: page.tsx, layout.tsx, [param]/
app/_client.*   the client entry — its presence turns on islands hydration
content/        markdown collections (frozen at build, verbatim .md projections)
june.config.ts  site metadata, agent-surface switches, resources
```
