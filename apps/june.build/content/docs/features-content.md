---
title: "Content: markdown without drift"
description: content/**/*.md freezes into a typed manifest at build time, and the .md projection serves your authored file byte-for-byte.
date: 2026-06-12
section: Features
order: "5"
---
## The feature

Author markdown in `content/`, and `june gen` (also run by every build)
freezes it into a typed manifest your routes import:

```
content/posts/*.md  →  june gen  →  app/_content.ts  →  POSTS / DOCS
```

The manifest carries each entry four ways: parsed frontmatter (`data`), the
body, rendered `html` — and `original`, the authored file verbatim. Dev and
the built worker read the SAME manifest, so there is no "works locally,
differs deployed" for content.

## The drift-free part

The `.md` projection serves `original` — frontmatter included, byte for byte.
Most frameworks reconstruct markdown from rendered HTML; June serves the
source, so a diff against your repo is empty. Verify it for this very page:

```bash
curl -s https://june.build/docs/features-content.md
```

That response IS the file in our repo — the same bytes `git show` would give
you. Our site tests assert this with a strict equality, not a contains.

## Why it matters

Agents prefer markdown — it's the densest, least ambiguous surface you can
serve them. Serving the authored source (instead of a lossy HTML→md
reconstruction) means what an agent reads is exactly what you wrote, with
frontmatter intact as structured metadata.
