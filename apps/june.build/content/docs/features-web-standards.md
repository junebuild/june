---
title: "Web Standards end to end"
nav: "Standards"
description: The whole framework is one fetch handler — Request in, Response out, Web Streams in between. Standards are the portability mechanism, not a checkbox.
date: 2026-06-12
section: Concepts
order: "11"
---
## The feature

June's entire request path is the Web platform's own vocabulary:

```ts
fetch(request: Request): Promise<Response>
```

That signature *is* the framework. Inside it: `URL` for routing, `Headers`
for negotiation, `ReadableStream` for HTML streaming
(`renderToReadableStream`, not the Node-only pipeable variant), Web `crypto`
for IDs, the Cache API where the host offers one. `@junejs/core` imports
zero `node:*` modules — enforced as an architectural rule, not a habit.

## Standards as the portability mechanism

This is why deployment is an adapter instead of a rewrite
([Deployment](/docs/04-deployment)):

- **workerd** speaks fetch natively — the built worker's `fetch()` IS the
  pipeline, no shim.
- **Bun** serves it directly (`Bun.serve({ fetch })`).
- **Node** needs only an edge adapter: `node:http` requests are converted to
  `Request` / from `Response` at the boundary (`Readable.toWeb` / `fromWeb`)
  — and nothing below the boundary knows.

Same story for data: the `db` contract is async-first because edge databases
(D1) are async — the standard-shaped surface is the one every target can
implement.

## Try it

The MCP endpoint is a plain standards handler too — `mcpHandler(request)`
takes a `Request` like everything else. There is no framework-specific
request object to learn and no middleware tower to thread:

```ts
// a June app is embeddable anywhere a fetch handler runs
const app = createApp({ appDir, config });
export default { fetch: (req: Request) => app.fetch(req) };
```

## Why it matters

Framework-specific request objects are how lock-in starts. When the
interface is the platform's own, your knowledge transfers in, your code
transfers out, and new runtimes are adapters — for us *and* for you.
