---
title: "OG images, typeset at the edge"
nav: "OG Image"
description: Social cards as a route that returns a PNG — satori + resvg in the worker, with runtime font subsetting so CJK titles work.
date: 2026-06-12
section: Features
order: "4"
---
## The feature

An og:image should not be a pre-generated file you forget to regenerate — it
is a route. This site serves `/og/<slug>.png` from the worker:

```
/og/<slug>.png → detect CJK → fetch font subset (text=title) → satori → resvg → PNG
```

satori lays out JSX inside the V8 isolate; resvg (Rust compiled to WASM)
rasterizes it. No browser, no puppeteer fleet — it runs where the rest of
your app runs.

## The CJK part

Full CJK families (Noto Sans TC / SC / JP / KR) weigh several MB per script —
far too heavy to ship in a worker, and a build can't know the glyph set of a
dynamic title ahead of time. The answer is runtime subsetting via Google
Fonts' `text=` parameter: download only the glyphs the title actually uses
(a few dozen KB), cache the subset for a week through workerd's Cache API.
Traditional and Simplified Chinese resolve to different fonts; Japanese mixes
kana with its own kanji forms — the detection step picks per title.

The full design walkthrough, with per-script samples, is in
[Typesetting CJK at the edge](/blog/2026-06-10-typesetting-cjk-at-the-edge).

## Try it

```bash
curl -o card.png https://june.build/og/2026-06-10-typesetting-cjk-at-the-edge.png
```

The route lives behind `app/_extra.tsx` — June's pre-route escape hatch for
responses `route()` has no projection for yet (binary bodies). One card
definition renders everywhere: workers-og rasterizes it on workerd, satori +
resvg-js rasterize the same JSX on the dev host — so the social card you
preview at `localhost:3000/og/…` is the one that deploys.

## Why it matters

Social cards are the page most teams generate with a headless browser in a
cron job. Making them a route means they're always current, deploy with the
app, and cost a font subset — not a Chromium.
