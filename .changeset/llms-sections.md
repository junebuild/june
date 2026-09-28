---
"@junejs/core": patch
"@junejs/server": patch
---

`/llms.txt` becomes the curated index llmstxt.org describes: every page, grouped under H2 sections, each with a one-line description, linking its markdown projection, with an `## Optional` section for links an agent can skip.

- **New route export `llms`** (`LlmsEntry` from `@junejs/core/route`): `{ path, title?, description?, section?, optional? }`, a list of them, a function returning either, or `false` to leave the route out. A dynamic route uses it to list its real pages (for example one per doc, from a content collection); without it, a `[param]` template is never listed, since an agent can't fetch it.
- **Static routes are listed by default** under `## Pages`, titled and described by their static `metadata`. A `metadata` function needs loader data, so the path stands in for the title.
- **Links are absolute and point at `<path>.md`** (`/` → `/index.md`), or at the page itself when the route disables `md`.
- Sections appear in first-seen order, and `## Optional` is always the file's last H2, after the tool sections. A section literally named `Optional` counts as optional, since that is llmstxt.org's reserved name. A page listed more than once, including `/a` and `/a/`, appears once. `agent.llms.sections` and `agent.llms.framework` keep working; custom sections sit before `## Optional`.

**Output change:** the flat `## Routes` list of bare paths (`- [/users](/users)`) is replaced by the `## Pages` section and any route-declared sections. `llmsTxt()` called without links still renders the old list.
