---
title: "Projections: one route, five surfaces"
description: Every route() projects HTML, JSON, markdown, and an agent manifest from one definition — nothing drifts because nothing is duplicated.
date: 2026-06-12
section: Features
order: "1"
---
## The feature

A June route is not a page that *also* has an API — it is one definition that
**projects** onto whatever surface the caller asks for:

```tsx
export default route({
  load: (ctx) => fetchPost(ctx.params.slug),
  view: (post) => <article>…</article>,   // GET /posts/x        → streamed HTML
  json: (post) => post,                   // GET /posts/x.json   → structured data
  md:   (post) => post.original,          // GET /posts/x.md     → authored markdown
  agent: (post) => manifest.resource(…),  // GET /posts/x.agent  → capability manifest
});
```

`load()` runs once; each projection renders the same data. There is no second
"API route" to keep in sync, no serializer drifting from the page.

## Try it on this site

Every page you're reading works this way. From your terminal:

```bash
curl https://june.build/why.md          # this page's authored markdown
curl https://june.build/benchmarks.json # the benchmark table as data
curl https://june.build/docs.json       # the docs index, structured
curl https://june.build/llms.txt        # the route map agents start from
```

The HTML you're looking at and the markdown an agent fetches come from the
same `route()` — same `load()`, same deploy.

## Why it matters

Half your traffic is becoming agents. A framework that only renders pixels
makes you hand-build (and hand-maintain) the machine surface. Projections
make it a property of the route, not a second codebase.
