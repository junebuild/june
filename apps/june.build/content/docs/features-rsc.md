---
title: "React Server Components, server-first"
nav: "RSC"
description: Every page is a server component tree rendered on the server; client code is an explicit island; actions are server functions with one authorization gate.
date: 2026-06-12
section: Concepts
order: "12"
---
## What June does today

- **Server components by default.** Every `page.tsx` and its layout chain
  render on the server — `view()` returns a server component tree, and the
  HTML that leaves the worker is fully resolved. No component code ships to
  the browser unless you ask.
- **Client components are explicit.** `<Island name="Counter">` marks the one
  subtree that hydrates, against a registry you write ([Islands](/docs/features-islands)).
  The boundary is visible in the code, not inferred by a bundler.
- **Actions are server functions.** `defineAction.run(input, ctx)` executes
  on the server and is passable to client components as a prop — the same
  definition is also an MCP tool behind the same gate ([MCP](/docs/features-mcp)).
- **One render core, everywhere.** Dev and the deployed worker render through
  the same pipeline; our parity suite asserts the output byte-for-byte.

## What June does NOT do yet

Stated plainly, because RSC claims are easy to inflate:

- **No streamed Suspense fallbacks** — pages flush fully resolved (the
  pipeline waits for `allReady`). Out-of-order streaming is on the roadmap.
- **No Flight-payload navigation** — navigations are full documents made
  instant by Speculation-Rules prerendering
  ([Navigation](/docs/features-navigation)), not RSC payload diffs.
- **Live RSC (server-push re-render)** exists and is measured on the
  experimental native runtime track — its push loop is the machinery behind
  the 73ms HMR number — but it is not part of the v0.1 host.

## Why server-first

Most pages are documents with islands of interactivity, and two audiences
read them: people (HTML) and agents (markdown, JSON — projections of the
same render, see [Markdown](/docs/features-markdown)). Rendering on the
server is what makes one definition serve both without shipping a runtime to
the client.
