---
title: "Navigation: instant without a client router"
nav: "Navigation"
description: Hover prerenders the next page (Speculation Rules), the click is zero-network, View Transitions animate the swap — the browser is the router.
date: 2026-06-12
section: Features
order: "9"
---
## The feature

June ships no client router — and navigation is still instant, because the
browser already has one. Every HTML page carries three things:

1. **Speculation Rules.** A `<script type="speculationrules">` block tells
   the browser to prerender same-origin links on hover (`eagerness:
   moderate`). By the time you click, the next page is already rendered —
   the click is a zero-network activation.
2. **A fallback for the rest.** Browsers without Speculation Rules get a
   tiny inline script that turns `pointerover` into `<link rel="prefetch">`
   — progressive enhancement, not a polyfill bundle.
3. **View Transitions.** `@view-transition { navigation: auto }` animates
   the document swap (and respects `prefers-reduced-motion`). Cross-document
   navigation stops looking like a full reload because the browser paints it
   as one continuous surface.

The agent surfaces are deliberately excluded: `.md`, `.json`, `.agent`, and
`/mcp` never prerender — machines don't hover.

## Try it right now

This page is the demo. Hover any link in the sidebar, watch the network
panel prerender it, then click: no fetch, one smooth transition. Everything
you just experienced shipped as ~1KB of declarative rules — not a router,
not a virtual DOM, not a client cache to invalidate.

## The posture

Client routers exist to make navigation fast and transitions smooth. The
platform now does both natively, so June's choice is the same one it makes
everywhere ([Standards](/docs/features-web-standards)): use the browser's
mechanism and ship nothing. This is also why we haven't built
Flight-payload navigation ([RSC](/docs/features-rsc)) — full documents made
instant cover most sites with zero client state to manage.

Configured by `speculation` in `june.config.ts`, on by default — the config
exists to turn it off.

## Why it matters

A client router is the single biggest source of accidental JavaScript: the
router pulls in state, the state pulls in hydration, and suddenly a
document site ships a runtime. Letting the browser navigate keeps the
zero-JS default ([Islands](/docs/features-islands)) honest.
