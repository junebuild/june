---
title: Dual audience
description: One page definition serves humans (HTML) and agents (markdown, JSON, MCP).
date: 2026-06-12
section: Concepts
order: "10"
---
## One definition, four surfaces

A page's default export is the view; named exports configure the other
surfaces. `.json` auto-derives from the loader data, so you only write what
you customize:

```tsx
import type { RouteContext, Loaded } from "@junejs/core/route";

export const loader = (ctx: RouteContext<{ slug: string }>) => fetchPost(ctx.params.slug);

export default function Post(post: Loaded<typeof loader>) {  // GET /posts/x   → streamed HTML
  return <article>…</article>;
}

export const md = (post: Loaded<typeof loader>) => post.original;   // GET /posts/x.md → AUTHORED markdown
export const metadata = (post: Loaded<typeof loader>) => ({ title: post.title });
// GET /posts/x.json → the loader data, auto-derived (no export needed)
```

The view receives loader data as **props**, the same shape the other three
projections take it (`md(data)`, `metadata(data)`, `.json = data`): one loader,
four surfaces, each a pure function of the data — nothing to drift. Deep child
components can reach the same data without prop-drilling via the escape-hatch
hook `useLoaderData<typeof loader>()` (also catches the Remix muscle-memory).

The `.md` projection serves the file you wrote, byte-for-byte — frontmatter
included. Most frameworks reconstruct markdown from rendered HTML; June serves
the source, so there is nothing to drift. A projection with no frontmatter of
its own (a generated `md()`, or the derived JSON block) opens with one built
from the page's metadata — `title`, `description`, `canonical` — so an agent
gets the same facts the HTML `<head>` carries. Actions are the capability surface —
each `defineAction()` is an MCP tool at `/mcp` (and a browser WebMCP tool).

## What agents discover automatically

- `/llms.txt` — route map + the framework's canonical names
- `/sitemap.xml`, `/robots.txt`, `/.well-known/api-catalog`
- `/.well-known/ai-catalog.json` (ARD) and `/.well-known/agent-skills/index.json`
  — the app's MCP server, its HTTP API, and a generated "how to use this site" skill
- `/mcp` — your `defineAction()`s as MCP tools: one definition is a UI server
  action AND an MCP tool AND a browser WebMCP tool
- `/openapi.json` + `POST /api/<id>` — the same actions as plain HTTP for
  OpenAPI and function-calling clients
- `<link rel="alternate" type="text/markdown">` pointing at a page's `.md`
  twin — on every page whose markdown projection is live (`agent.discovery`
  on, and the route doesn't set `md = false`)
- `Vary: Accept` on pages — the same URL answers HTML or Markdown (whichever the
  client's `Accept` ranks higher, q-values included), so caches key on the header
- A 404 an agent can act on: `Accept: text/markdown` (or a `.md` URL) gets a
  Markdown 404 linking `/llms.txt`, `/sitemap.xml`, `/mcp` and `/openapi.json`;
  JSON clients get `{ error, code: "not_found", path, hint }`

## Actions are one gate

`defineAction({ id, description, input, run })` — `run(input, ctx)` receives
the same context (user, session, resources) whether the caller is your UI or
an agent at `/mcp`. One authorization model, two kinds of callers.

## The posture

Human-intent optimizations (Speculation-Rules prerender, View Transitions)
apply to the HTML surface only; agent surfaces stay deliberately plain.
Machines don't need view transitions.
