---
title: "Runtime: Bun-first toolchain, runtime-agnostic core"
nav: "Runtime"
description: One tool runs install/test/dev; the core assumes no runtime at all — which is why the same app serves from Bun, Node, and workerd.
date: 2026-06-12
section: Features
order: "9"
---
## The feature

June's runtime story is three layers, each with a different promise:

| layer | promise |
| --- | --- |
| `@junejs/core` | **runtime-agnostic** — Web standards only, zero `node:*`, zero drivers |
| host interface | Bun and Node implementations of one seam (serve, spawn, sqlite) |
| production | **workerd** — V8 isolates, neither Node nor Bun in the serving path |

The toolchain is **Bun-first**: one tool covers install, test, and `june
dev` — no tsx + nodemon + jest + esbuild assembly. That's the no-glue
philosophy applied to the toolchain itself.

The core being runtime-agnostic is not hygiene, it's the deploy story:
because nothing in the render core assumes a runtime, dev (Bun or Node) and
production (workerd) run the SAME code, and parity is a property instead of
a test burden.

## The Node host is a tested claim

`june dev` detects its runtime; on Node it serves through `node:http` — with
one bonus Bun can't offer: real RFC 8297 `103 Early Hints` interim responses.
CI runs the full dev server under Node against real HTTP on every push
(`scripts/smoke-node.ts`), so "works on Node" is continuously asserted, not
assumed.

```bash
node --import tsx scripts/smoke-node.ts
# june dev → http://localhost:4399  (host: node)
# node-host smoke: OK (serve, routes, discovery, mcp)
```

## The experimental track

There is also an owned Rust+V8 runtime (V8 snapshot boot ~12ms, bundled
first render ~22ms, push-based HMR) — measured and public
([benchmarks](/benchmarks)) but explicitly experimental. v0.1 ships on the
Bun/Node host; the native runtime is the roadmap, not the present.

## Why it matters

Runtime lock-in is glue you can't see until you migrate. A core that speaks
only Web standards keeps every door open — including the one we're building
toward.
