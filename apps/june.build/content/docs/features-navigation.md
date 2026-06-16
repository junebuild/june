---
title: "Navigation: instant without a client router"
nav: "Navigation"
description: Hover prerenders the next page (Speculation Rules), the click is zero-network, View Transitions animate the swap — the browser is the router.
date: 2026-06-12
section: Features
order: "23"
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
   as one continuous surface. It is pure CSS — no JavaScript, no
   `document.startViewTransition()` (that API is for same-document SPAs) —
   and it requires **both** the outgoing and incoming page to carry the
   opt-in, on a **same-origin** navigation. June emits the rule on every
   page, so both ends always qualify.

The agent surfaces are deliberately excluded: `.md`, `.json`, and `/mcp`
never prerender — machines don't hover.

## Try it right now

This page is the demo. Hover any link in the sidebar, watch the network
panel prerender it, then click: no fetch, one smooth transition. Everything
you just experienced shipped as ~1KB of declarative rules — not a router,
not a virtual DOM, not a client cache to invalidate.

## The posture

Client routers exist to make navigation fast and transitions smooth. The
platform now does both natively, so June's default is the same choice it
makes everywhere ([Standards](/docs/features-web-standards)): use the
browser's mechanism and ship nothing. This is also why a full document — not
a Flight payload ([RSC](/docs/features-rsc)) — is what crosses the wire: it
covers most sites with zero client state to manage.

When an app-like surface genuinely needs in-memory state to survive a
navigation (a dashboard, an open websocket), the opt-in
[Client Router](/docs/features-client-router) adds soft swaps as progressive
enhancement — off by default, and this site keeps it off.

Configured by `speculation` in `june.config.ts`, on by default — the config
exists to turn it off.

## The fine print

This default leans on a few browser behaviors. They are load-bearing and easy
to get subtly wrong, so they are stated here rather than left implicit:

- **Back/forward is instant via bfcache** — the browser restores a live page
  snapshot, no re-render. But a page served with `Cache-Control: no-store` is
  **disqualified** from bfcache in Chrome and Firefox, so don't reach for
  `no-store` on HTML to force revalidation; use `no-cache` or a short
  `max-age`. (Chrome is trialing a conditional relaxation — verify against
  your targets; behavior is in flux as of 2026-06.)
- **Speculative requests are detectable server-side** — a prerender carries
  `Sec-Purpose: prefetch;prerender` (a prefetch, just `Sec-Purpose: prefetch`),
  so a route can skip side effects until the page is actually activated.
- **Hashed assets are served `immutable`** ([the worker sets it](/docs/features-runtime)),
  so the browser skips even the conditional revalidation request within the
  asset's lifetime — the per-navigation cost stays at the document, not its CSS/JS.

## Why it matters

A client router is the single biggest source of accidental JavaScript: the
router pulls in state, the state pulls in hydration, and suddenly a
document site ships a runtime. Letting the browser navigate keeps the
zero-JS default ([Islands](/docs/features-islands)) honest.
