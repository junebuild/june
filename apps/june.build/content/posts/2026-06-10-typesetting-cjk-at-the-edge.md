---
title: "Typesetting CJK at the edge: og:image and font subsetting"
date: 2026-06-10
description: This post's social card is typeset live on Cloudflare Workers — CJK titles included.
tags: [og-image, fonts, edge, cjk]
---

The og:image for a post here is not a pre-generated file — it's a route that
returns a PNG: satori lays out JSX inside a V8 isolate, resvg (Rust compiled
to WASM) rasterizes it, and no browser is involved anywhere.

CJK is the real test: a full CJK family (Noto Sans TC/JP/KR) weighs several
MB per script — far too heavy to ship in a worker. The answer is Google
Fonts' `text=` parameter — **download only the glyphs the title actually
uses**. A subset is a few dozen KB, cached for a week through workerd's
Cache API.

```
/og/<slug>.png → detect CJK → fetch font subset (text=title) → satori → resvg → PNG
```

The same pipeline covers every CJK script with no per-language work:

- 邊緣排版與字型子集化 (Traditional Chinese)
- フォントのサブセット化 (Japanese)
- 글꼴 서브셋 (Korean)

A common alternative is self-hosting fonts at build time (our asset pipeline
will do that too), but a build cannot know the glyph set of a dynamic title
ahead of time — runtime subsetting is the right call for the og:image case.
