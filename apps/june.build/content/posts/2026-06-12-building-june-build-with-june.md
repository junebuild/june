---
title: Building june.build with June
date: 2026-06-12
description: Our site is its own demo — every page serves humans and agents from one definition.
tags: [dogfood, dual-audience]
---

This site is built with June and deployed on Cloudflare Workers. That sentence
is most of the pitch, so let's prove it instead of repeating it.

## One route, five surfaces

Every page here is a single `route()` definition with projections:

```
GET /why            → streamed HTML (you, probably)
GET /why.md         → clean markdown (an agent, probably)
GET /blog.json      → structured frontmatter (a crawler with taste)
GET /why.agent      → a capability manifest (an agent deciding what to do)
POST /mcp           → tools/call search_site, get_page (an agent at work)
```

The markdown an agent fetches for this very post is **the file we authored,
byte for byte** — frontmatter included. Most frameworks reconstruct markdown
from rendered HTML; June serves the source. There is nothing to drift.

## Try it from your terminal

```bash
curl https://june.build/blog/2026-06-12-building-june-build-with-june.md
curl -X POST https://june.build/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_site","arguments":{"query":"cold start"}}}'
```

## What the human side gets

Hover any link: the page prerenders in the background (Speculation Rules) and
the click is a zero-network activation with a view transition. No client
JavaScript was written for any of this — the browser is the client runtime.
