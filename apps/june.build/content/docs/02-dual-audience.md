---
title: Dual audience
description: One route() definition serves humans (HTML) and agents (markdown, JSON, MCP).
date: 2026-06-12
---
## One definition, four surfaces

```tsx
export default route({
  load: (ctx) => fetchPost(ctx.params.slug),
  view: (post) => <article>…</article>,   // GET /posts/x        → streamed HTML
  json: (post) => post,                   // GET /posts/x.json   → structured data
  md:   (post) => post.original,          // GET /posts/x.md     → AUTHORED markdown
  metadata: (post) => ({ title: post.title }),
});
```

The `.md` projection serves the file you wrote, byte-for-byte — frontmatter
included. Most frameworks reconstruct markdown from rendered HTML; June serves
the source, so there is nothing to drift. Actions are the capability surface —
each `defineAction()` is an MCP tool at `/mcp` (and a browser WebMCP tool).

## What agents discover automatically

- `/llms.txt` — route map + the framework's canonical names
- `/sitemap.xml`, `/robots.txt`, `/.well-known/api-catalog`
- `/mcp` — your `defineAction()`s as MCP tools: one definition is a UI server
  action AND an MCP tool AND a browser WebMCP tool

## Actions are one gate

`defineAction({ id, description, input, run })` — `run(input, ctx)` receives
the same context (user, session, resources) whether the caller is your UI or
an agent at `/mcp`. One authorization model, two kinds of callers.

## The posture

Human-intent optimizations (Speculation-Rules prerender, View Transitions)
apply to the HTML surface only; agent surfaces stay deliberately plain.
Machines don't need view transitions.
