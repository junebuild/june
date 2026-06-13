---
title: "Built-in llms.txt"
nav: "llms.txt"
description: The agent discovery surface — llms.txt, sitemap, robots, api-catalog, and per-route manifests — derives from your routes automatically.
date: 2026-06-12
section: Features
order: "2"
---
## The feature

An agent landing on a June app finds its way without scraping. These derive
from the route graph and your actions — you author none of them:

| surface | what an agent learns |
| --- | --- |
| `/llms.txt` | the route map + each route's markdown projection |
| `/sitemap.xml`, `/robots.txt` | the classic crawler contract |
| `/.well-known/api-catalog` | machine-readable API listing |
| `/mcp` | your actions as MCP tools an agent can call |
| `Link` response header | discovery advertised on every HTML response |

It's on by default and one switch turns it all off (`agent: { enabled:
false }`) — the framework's defaults philosophy: removable, not assembly
required.

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
