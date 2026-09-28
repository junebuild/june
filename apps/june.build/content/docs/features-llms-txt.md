---
title: "Built-in llms.txt"
nav: "llms.txt"
description: The agent discovery surface — llms.txt, sitemap, robots, api-catalog, the ARD catalog, a generated agent skill, and per-route manifests — derives from your routes automatically.
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
| `/.well-known/api-catalog` | machine-readable API listing ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727)): each API an `item`, with its description and docs |
| `/.well-known/ai-catalog.json` (also `/.well-known/ard.json`) | one catalog of the app's agentic resources — its MCP server and its skill — for [ARD](https://agenticresourcediscovery.org/) crawlers ([AI Catalog](https://github.com/Agent-Card/ai-catalog) format) |
| `/.well-known/agent-skills/index.json` | a generated [Agent Skill](https://agentskills.io/) that teaches an agent to use this site ([discovery RFC v0.2.0](https://github.com/cloudflare/agent-skills-discovery-rfc)) |
| `/mcp` | your actions as MCP tools an agent can call |
| `/.well-known/mcp/server-card.json` | the MCP server's identity and how to connect (when MCP is on) |
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
      lastModified: (d.data.updated ?? d.data.date) as string | undefined,
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
    lastModified: (p.data.updated ?? p.data.date) as string | undefined,
  }));
```

An entry is `{ path, title?, description?, section?, optional?,
lastModified? }`. A static
route can export a single object (`export const llms = { section: "Project" }`)
to change its section, and `export const llms = false` leaves a route out.
Sections appear in the order they're first seen, and `## Optional` is always
last, after the tool sections. `Optional` is llmstxt.org's reserved name, so an
entry filed under a section called `Optional` counts as optional too.

## When to use

An agent choosing between ten tools picks the one that says what it's for.
June can't write that for you, but it gives the answer a fixed place:
`agent.llms.whenToUse` renders as a `## When to use` list right under the
summary, before any other section.

```ts
// june.config.ts
export default defineJune({
  agent: {
    llms: {
      whenToUse: [
        "You need an invoice PDF from an order id: call `render_invoice`.",
        "You're reconciling payouts: read /payouts.md for the schedule and fees.",
      ],
    },
  },
});
```

Write jobs, not slogans: each line should name a task an agent might be doing
and what to use for it.

## The sitemap lists every page

`/sitemap.xml` uses the same page list as `llms.txt`. A static route is one
URL. A dynamic route contributes the pages its `llms` entries name, which is
the same runtime-safe hook `llms.txt` runs. A `[slug]` template that names no
pages stays out, because a template isn't a URL.

`llms = false` behaves differently for the two kinds of route. On a static
route it only takes the page out of `llms.txt`; the page stays in the
sitemap. On a dynamic route it removes the route's pages from both
`llms.txt` and the runtime sitemap, because the `llms` entries were the only
list of those pages. A `static()` build still lists them through
`staticPaths`.

`staticPaths` stays a build-time hook, so a crawler fetching `/sitemap.xml`
never triggers it. The one exception is the `static()` target, which already
runs `staticPaths` to prerender. Its prerendered sitemap lists those pages too,
except with i18n, where they arrive locale-prefixed.

An entry's `lastModified` becomes that page's `<lastmod>`: a `"2026-09-27"`
string, a full ISO timestamp, or a `Date` (a YAML `date:` field works as-is).
June never substitutes the build time. A page with no date gets no
`<lastmod>`, because a wrong date tells crawlers to re-read (or skip) the
wrong pages.

```ts
export const llms = (): LlmsEntry[] =>
  DOCS.map((d) => ({
    path: `/docs/${d.slug}`,
    lastModified: d.data.updated ?? d.data.date,
  }));
```

## The generated skill and the catalog

Every app publishes one skill, named after its host (`june.build` →
`june-build`), at `/.well-known/agent-skills/<name>/SKILL.md`. It tells an
agent how to use the site: start at `llms.txt`, whose links point at each
page's Markdown version; read a page as Markdown where it offers one (the page
advertises it with `<link rel="alternate" type="text/markdown">`; fetch `.md`
or send `Accept: text/markdown`) or JSON (`.json`) likewise, since a route that
turns a projection off answers 404 there; and call each tool at `/mcp`, listed
with its parameters and description. The index next to it carries the
SKILL.md's `sha256` digest, so an agent can verify what it downloaded.

The AI Catalog lists the same resources for ARD: the MCP server card and the
skill, each with a `urn:air:<host>:…` identifier, under a
`did:web:<host>` host. `robots.txt` points at it (`Agentmap:`), and so do
every page's `<link rel="ai-catalog">` and `Link` header. Both catalogs name
absolute URLs, so a static build writes them only when it knows the public
origin (`site.url` or `deploy.domain`) and deploys at the domain root.

## Try it on this site

```bash
curl https://june.build/llms.txt
curl https://june.build/.well-known/api-catalog
curl https://june.build/.well-known/ai-catalog.json
curl https://june.build/.well-known/agent-skills/index.json
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
