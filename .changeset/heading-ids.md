---
"@junejs/core": patch
"@junejs/server": patch
---

Content headings are linkable, and every consumer shares one algorithm to link them.

- **`entry.html` headings carry a GitHub-compatible `id`** at every level (`<h2 id="q--a">Q &amp; A</h2>`), and nothing else: no injected link or class. Rules: lowercase; punctuation, symbols, and emoji drop; letters of every script stay; each space becomes `-`; repeats get `-1`, `-2` in document order. A heading with nothing left becomes `section`. A heading written as raw HTML keeps its attributes; an `id` the author wrote is reused as-is, and a generated `id` never repeats one already in the document.
- **`entry.headings`**: `{ depth, text, id }[]` in document order, frozen into `_content.ts`. Use it for a table of contents or a structured projection.
- **`@junejs/core/slug`** exports `slugify` and `createSlugger`, the same algorithm. Code that derives ids elsewhere (for example a search index over the markdown source) imports it, so its deep links match the rendered anchors exactly.
- The `.md` projection is unchanged (the authored bytes).

**Breaking for HTML post-processors:** headings were previously emitted bare (`<h2>…</h2>`). A regex that only matches bare headings, such as `/<h([23])>/`, no longer matches.

To migrate:
- Accept attributes, e.g. `/<h([2-4])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/`, and reuse the `id` that is already there instead of assigning a new one.
- If you only built your own table of contents, read `entry.headings` instead.
- If you slug headings anywhere else, switch to `createSlugger` from `@junejs/core/slug`, or ids will disagree with the rendered anchors.
