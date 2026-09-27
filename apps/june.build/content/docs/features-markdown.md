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

## Linkable headings

The HTML view gives every heading an `id`, with GitHub's rules, so a link you'd
write on GitHub works here too:

```md
## Q & A           →  <h2 id="q--a">Q &amp; A</h2>
### Use `ctx.user`  →  <h3 id="use-ctxuser">Use <code>ctx.user</code></h3>
## 邊緣排版          →  <h2 id="邊緣排版">邊緣排版</h2>
```

- **The rules:** lowercase; punctuation, symbols, and emoji drop; letters of
  every script stay; each space becomes `-`; a repeated heading gets `-1`, `-2`
  in document order. A heading with nothing left becomes `section`.
- **Raw HTML headings count too.** A heading you write as HTML keeps its
  attributes. If you gave it an `id`, that `id` is kept as your explicit anchor.
  A generated `id` never repeats one already on the page.
- **Only the `id`.** June adds no link or class. How an anchor looks is your
  app's decision; this site adds its `#` in the page component.
- **`entry.headings`** lists each heading as `{ depth, text, id }`, in order.
  Use it for a table of contents (the "On this page" rail here), or put it in a
  `.json` projection so an agent gets the page's structure and a deep link to
  every section.
- **One algorithm, shared.** Code that needs the same ids, such as a search
  index built from the markdown source, imports it rather than re-implementing:

```ts
import { createSlugger, slugify } from "@junejs/core/slug";

const slug = createSlugger(); // one per document, called in heading order
slug("Setup"); // "setup"
slug("Setup"); // "setup-1"
```

The `.md` projection is unchanged: it's still your file, with no ids added.

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
