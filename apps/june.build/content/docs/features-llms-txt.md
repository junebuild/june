---
title: "Built-in llms.txt"
nav: "llms.txt"
description: The agent discovery surface — llms.txt, sitemap, robots, api-catalog, and per-route manifests — derives from your routes automatically.
date: 2026-06-12
section: Features
order: "29"
sources: [packages/core/src/discovery.ts, packages/core/src/route.ts, packages/june/src/llms-links.ts]
---
## The feature

An agent landing on a June app finds its way without scraping. These derive
from the route graph and your actions — you author none of them:

| surface | what an agent learns |
| --- | --- |
| `/llms.txt` | a curated index: every page, grouped by section, described, linking its markdown |
| `/sitemap.xml`, `/robots.txt` | the classic crawler contract |
| `/.well-known/api-catalog` | machine-readable API listing |
| `/mcp` | your actions as MCP tools an agent can call |
| `Link` response header | discovery advertised on every HTML response |

It's on by default and one switch turns it all off (`agent: { enabled:
false }`) — the framework's defaults philosophy: removable, not assembly
required.

## What goes in llms.txt

[llmstxt.org](https://llmstxt.org) asks for a **curated** file, not a sitemap:
links grouped under H2 sections, each with a one-line description, and an
`## Optional` section for links an agent can skip when its context is short.
June builds that from your routes:

- **A static route** is listed under `## Pages`, titled and described by its
  static `metadata`. A `metadata` function needs loader data, so its path
  stands in for the title.
- **A dynamic route** (`[slug]`) is a template an agent can't fetch, so it's
  listed only if it names its real pages.
- **Every link points at the page's `.md` projection**, so an agent reads the
  page, not its HTML. A route that turned `md` off links the page itself.

A route shapes its entries with an `llms` export:

```ts
// app/docs/[slug]/page.tsx: one link per doc, grouped like the sidebar
import type { LlmsEntry } from "@junejs/core/route";
import { docSections } from "../_sections";

export const llms = (): LlmsEntry[] =>
  docSections().flatMap((s) =>
    s.docs.map((d) => ({
      path: `/docs/${d.slug}`,
      title: String(d.data.title ?? d.slug),
      description: d.data.description ? String(d.data.description) : undefined,
      section: s.title || "Docs",
    })),
  );
```

```ts
// app/blog/[slug]/page.tsx: posts are background, so they go under Optional
export const llms = (): LlmsEntry[] =>
  POSTS.map((p) => ({
    path: `/blog/${p.slug}`,
    title: String(p.data.title ?? p.slug),
    description: p.data.description ? String(p.data.description) : undefined,
    optional: true,
  }));
```

An entry is `{ path, title?, description?, section?, optional? }`. A static
route can export a single object (`export const llms = { section: "Project" }`)
to change its section, and `export const llms = false` leaves a route out.
Sections appear in the order they're first seen, and `## Optional` is always
last.

## Try it on this site

```bash
curl https://june.build/llms.txt
curl https://june.build/.well-known/api-catalog
curl -sI https://june.build/why | grep -i '^link:'
```

The `llms.txt` here also carries the framework's canonical names — which
package is ours (`@junejs/core`, `create-june`) and which similarly-named
ones are not. Agents misinstalling lookalike packages is a real failure mode;
the discovery surface is where you correct it.

## Why it matters

Discovery is the cheapest half of being agent-ready: if an agent's first
fetch answers "what is here and how do I read it," everything downstream
(markdown projections, MCP tools) gets found instead of guessed at.
