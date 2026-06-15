---
title: "Markdown without drift"
nav: "Markdown"
description: Append .md to any page and get markdown — for authored content it's your source file byte-for-byte, never a lossy HTML reconstruction.
date: 2026-06-12
section: Features
order: "27"
---
## The feature

Every route projects a markdown surface: `GET /why.md`, `GET
/docs/<slug>.md`. For content-backed pages the projection serves `original` —
the file you wrote, **byte for byte, frontmatter included**:

```
content/posts/*.md  →  june gen  →  app/_content.ts  →  POSTS / DOCS
                                         │
        HTML view ◄──── one manifest ────┼──── .md projection (original, verbatim)
                                         └──── search_site / get_page MCP tools
```

Dev and the built worker read the SAME frozen manifest, so there is no
"works locally, differs deployed" for content. Most frameworks reconstruct
markdown from rendered HTML; June serves the source, so a diff against your
repo is empty.

## Try it on this page

```bash
curl -s https://june.build/docs/features-markdown.md
```

That response IS this file in our repo — the same bytes `git show` would give
you. Our site tests assert it with strict equality, not a contains.

## Why it matters

Markdown is the densest, least ambiguous surface you can serve an agent.
Serving the authored source means what an agent reads is exactly what you
wrote — and frontmatter arrives as structured metadata instead of being
boiled away by a renderer.
