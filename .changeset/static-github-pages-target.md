---
"@junejs/core": patch
"@junejs/server": patch
---

Add a first-class static (GitHub Pages) deploy target.

- `staticSite()` adapter (`runtime: "static"`): `june build` prerenders every route
  + projection to `dist/static/` (page HTML as `<stem>/index.html`, flat `.md`/`.json`,
  `_june/` assets, `favicon.svg`, `404.html`, `.nojekyll`). `deploy: { target: "static" }`
  resolves it by name — no adapter import. `june deploy` is build-only for this target.
- `staticPaths` route export: a dynamic catch-all lists the concrete pathnames to
  prerender (locale-expanded), so content-driven routes can ship as static files.
- `basePath` config: prefixes the framework asset URLs in the rendered document, so a
  site served under a subpath (e.g. a GitHub Pages project path) resolves its assets.

All additive — `workers()`/`vercel()`/`deno()` and root deploys are unchanged.
