---
"@junejs/core": minor
"@junejs/server": patch
---

Every non-home page now carries a schema.org `BreadcrumbList` in its JSON-LD,
using the same single-`@graph` shape as the homepage's `WebSite`.

- **The trail comes from the URL.** It starts at the site home, named by the
  short part of `site.name`, or at a locale's own home (`/de`). It continues
  through each ancestor path that is a page and ends with the page itself,
  named by its title.
- **Only declared pages count as ancestors.** An ancestor gets a crumb only if
  it resolves to a route matched with no params.
  - A path that matches nothing is skipped.
  - So is a dynamic match, since only its data says whether it exists.
  - Ancestors are resolved, never loaded.
- **Ancestor names.** An ancestor is named by its static `metadata.title`.
  Failing that, it's named by its humanized URL segment.
- **New `Metadata.breadcrumb`.** Set it to `false` to opt a page out, or to an
  array of `{ name, path }` crumbs after the home to set the trail yourself. A
  `metadata` function can build that array from loaded data.
- **Same gates as the canonical.** A trail needs a public origin, and `noindex`
  pages get none. Item URLs are absolute and include any `basePath`. The last
  item is the page's canonical URL.
- **Streamed pages included.** Pages rendered with `loading.tsx` carry the
  trail too. Pages served by the experimental RSC renderer get none: that path
  doesn't pass route metadata to the document yet.
- **`Breadcrumb` type.** It is exported from `@junejs/core/document`.
