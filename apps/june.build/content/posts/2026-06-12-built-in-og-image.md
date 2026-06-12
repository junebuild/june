---
title: "Built-in og:image: every page gets a live social card"
date: 2026-06-12
description: No pre-rendered files, no headless browser — /og/<slug>.png typesets each page's card in the worker, and dev previews the same pixels.
tags: [og-image, fonts, edge]
---

Share any page of this site and the social card you see was typeset **at
request time**, in the worker. This post's own card:

![The social card for this very post, rendered live](/og/2026-06-12-built-in-og-image.png)

## Every page, one mechanism

`/og/<slug>.png` resolves blog posts, docs pages, and the core pages alike —
each HTML page points to its card with a plain `og:image` meta tag the route
declares in its `metadata`. There is no image directory to regenerate and
nothing to forget: a new post gets a card the moment it exists, because the
card *is* the post's title rendered through one JSX definition.

## No browser anywhere

satori lays out the JSX (its own flexbox + font shaping), resvg — Rust
compiled to WASM — rasterizes it to PNG. The classic alternative is a
headless Chromium screenshotting a hidden page in a cron job; this is a
50KB-class route instead.

Fonts load at runtime with Google Fonts' `text=` subsetting: only the glyphs
the title actually uses, a few dozen KB, cached at the edge. That is also
what makes CJK titles viable — the full story is in
[Typesetting CJK at the edge](/blog/2026-06-10-typesetting-cjk-at-the-edge).

## Dev shows the real card

The same card definition renders on both hosts: workers-og rasterizes it on
workerd; on the dev host the identical JSX goes through satori plus a native
resvg binding. `localhost:3000/og/anything.png` during development IS the
card that ships — no "works on prod, blank in dev" class of surprise.

## Try it

```bash
curl -o card.png https://june.build/og/why.png            # a core page
curl -o card.png https://june.build/og/features-mcp.png   # a docs page
curl -o card.png https://june.build/og/$(date +%s).png    # unknown slug → site card
```
