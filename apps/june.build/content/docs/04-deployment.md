---
title: "Deployment"
description: One portable core, one host interface, one adapter per target — Workers today, self-hosted and Vercel on the same seam.
date: 2026-06-12
---
## The design

June separates what renders from where it runs:

- **The framework core is portable.** Routes, projections, actions, the agent
  surface — all of it speaks Web standards (`Request` in, `Response` out) and
  assumes no runtime. It is the same code on every target; deployment never
  changes behavior.
- **The host interface is the seam.** Everything standards don't cover —
  binding a port, opening a local database, spawning a module — lives behind
  one small interface. A deploy target is an *implementation of that
  interface*, not a fork of the framework.

So adding a target means writing an adapter, and an adapter cannot diverge
from the framework: dev, self-hosted, and edge all run the same render core
(our parity suite asserts it byte-for-byte).

## Targets

| target | how | status |
| --- | --- | --- |
| **Cloudflare Workers** | `june deploy` — Rolldown bundle + frozen manifest, wrangler upload | shipped; `--dry-run` runs in CI |
| **Self-hosted (Bun / Node)** | the host layer serves the same pipeline over `Bun.serve` / `node:http` | serving layer CI-tested on both runtimes; a production `june start` verb is roadmap |
| **Vercel** | an adapter over the same host seam (Build Output API) | planned |
| **Own Rust+V8 runtime** | the experimental flagship — V8 snapshot boot, un-bundled dev | experimental track ([Runtime](/docs/features-runtime)) |

The deploy verb is fixed; the target is configuration. Resources follow the
same model: declare `db` / `blob` / `kv` once, and each target maps them to
its native services (D1/R2/KV on Workers, SQLite + disk locally).

## Why this shape

Deployment lock-in is usually accidental: the framework leaks its favorite
runtime's APIs until leaving costs a rewrite. June's rule — core speaks
standards, hosts implement one interface — makes the exit door part of the
architecture. The target you pick is a decision you can revisit.

## Honest notes

- Workers is the one target you can deploy to today; the table above is the
  design and its current state, not a promise that everything works now.
- Node self-hosting note: the Node host actually exceeds the others in one
  spot — real RFC 8297 `103 Early Hints` interim responses.
