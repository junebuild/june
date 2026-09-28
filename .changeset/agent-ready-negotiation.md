---
"@junejs/core": patch
"@junejs/server": patch
---

Agent-ready content negotiation defaults: caches, 404s and markdown metadata.

- `withAssets` adds `Vary: Accept` to prerendered page responses — both the
  HTML asset and the Markdown served for `Accept: text/markdown` — merging with
  any `Vary` the asset layer already set. The same URL answers either body, so a
  cache that ignored Accept could hand an agent the HTML. Every document the
  pipeline renders (streamed pages and the 404 included) varies on Accept too.
- Accept negotiation honors q-values, and the pipeline and `withAssets` share
  one decision (`acceptTarget`). Markdown or JSON is served when the client
  lists it at least as preferred as HTML. A client that ranks HTML higher
  (`text/html, text/markdown;q=0.5`) gets HTML, where before any mention of
  `text/markdown` won. A browser's Accept is unaffected. When markdown is
  preferred but a prerendered page has no `.md` asset (the route sets
  `md = false`), the worker hands the request to the pipeline, which returns the
  disabled projection's 404, instead of serving the HTML asset. A malformed q
  (outside RFC 9110's qvalue grammar) reads as the default 1.
- `withAssets` never answers a negotiated projection with the prerendered HTML
  document:
  - `Accept: application/json` gets the `.json` asset of a `json()` route, and
    otherwise the pipeline (derived loader data, or 404 when json is disabled).
  - The client router's soft-nav fragment request goes to the pipeline's
    fragment. Before, a soft nav to a prerendered page received the full
    document, which the router morphed into `[data-june-root]` as inner HTML,
    nesting a second root plus head tags. Such soft navs now render in the worker
    instead of hitting the asset cache.
- A 404 an agent can act on: an `Accept: text/markdown` (or `.md`) miss returns
  a Markdown body linking `/llms.txt`, `/sitemap.xml` and `/mcp` (only the
  surfaces the app serves). The JSON 404 keeps `error` and `path` and adds
  `code: "not_found"` and a `hint`. Every 404 variant carries `Vary: Accept`.
- Pages advertise their markdown twin with
  `<link rel="alternate" type="text/markdown" href="….md">` (`/index.md` for
  the home page), gated with the rest of `agent.discovery` and omitted when the
  route sets `md = false`.
- A markdown projection with no frontmatter of its own opens with one built
  from the page metadata: `title`, `description`, and `canonical`, which follows
  the same rules as the HTML `<link rel="canonical">`. Authored markdown that
  already has frontmatter is still served byte-for-byte.
- `@junejs/core/document` exports `pageCanonical()`. The Document's canonical
  now goes through it too.
