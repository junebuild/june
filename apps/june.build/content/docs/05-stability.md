---
title: "Stability & roadmap"
nav: "Stability"
description: What you can build on today, what's still moving, and what's experimental — June is 0.0.x, and this page says exactly where each piece stands.
date: 2026-06-15
section: Get started
order: "4"
---
## Where June stands

June is `0.0.x preview`. That doesn't mean everything is in flux — the core
shape is settled and dogfooded (this site runs on it). It means the surface is
still being drafted in places, and we'd rather tell you exactly where than imply
a false 1.0.

## The three tiers

| tier | what it means |
| --- | --- |
| **Stable** | The shape is settled. Signatures may get minor tweaks, but the model won't change under you. |
| **Changing** | Works today and is dogfooded, but the API is still being refined — expect renames and small breaks. |
| **Experimental** | Opt-in and measured, but not the v0.1 default. Use it to look ahead, not to ship production on. |

### Stable

- **Routing & projections** — file-based `route()`, the four surfaces (HTML /
  `.md` / `.json` / `/mcp`), content negotiation, and opt-in `prerender`.
- **Actions & the agent surface** — `defineAction()` as a UI action *and* an MCP
  tool behind one `run(input, ctx)` gate; `/mcp`, `/llms.txt`, `sitemap.xml`,
  and the API catalog derived from the route graph.
- **Rendering** — server-first RSC, explicit client islands, and browser-native
  navigation (Speculation Rules + View Transitions).
- **Styling** — `app/global.css` (auto-linked) and CSS Modules, compiled with
  Lightning CSS.
- **Build & deploy** — `june build` / `june deploy`, and the `workers()`,
  `vercel()`, and `deno()` adapters — all shipped; the demo app and this site
  run on them.

### Changing

- **Data layer** — `resources`, the ambient `import { db }`, and the Juno
  query/migration layer work and are dogfooded, but the surface is still being
  refined.
- **Auth** — Better Auth is the blessed default; a first-class integration
  (session → `ctx` principal → `/mcp` scoping) is in progress. Bring-your-own
  works today.
- **Config & CLI** — the `june.config.ts` shape and some CLI flags may still
  shift.

### Experimental

- **Owned Rust+V8 runtime** — boots in ~14 ms with a V8 snapshot and un-bundled
  dev. Measured, but the v0.1 default host is Bun/Node. See
  [Runtime](/docs/features-runtime).
- **Server-reactive live RSC** — server-driven live updates; exists and is
  measured, ships off by default.

## What `0.0.x` means

Pre-1.0, a minor or patch release *may* include a breaking change — that's the
honest reading of semver below 1.0, not a surprise. We won't rename things for
fun, and when a break lands we say so in the changelog with the migration.
Benchmarks on this site are dev-machine numbers with published methodology and a
named run behind each — re-run them, don't trust them.

## How we signal changes

- **Changelog** — every breaking change is listed with its migration.
- **This page** — the tier table is updated as pieces graduate (Changing →
  Stable) or land (Experimental → default).
- **The site is the spec mirror** — `june.build` is dogfooded on June, so if a
  doc claims something, the running site does it too.
