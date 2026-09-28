---
"@junejs/core": minor
"@junejs/server": minor
---

Site identity in JSON-LD, a "When to use" slot in llms.txt, and a sitemap that lists every page.

- `site.organization` (`{ name?, url?, logo?, email?, telephone?, sameAs?, address? }`):
  the homepage JSON-LD becomes a schema.org `@graph` with an `Organization`
  that the `WebSite` names as its publisher. Email/telephone become a
  `ContactPoint`, `sameAs` merges with the `site.twitter` profile URL, and
  nothing is emitted until the app declares it.
- `site.jsonLd`: extra schema.org nodes (SoftwareApplication, FAQPage, …)
  appended to the same `@graph` (a node's own top-level `@context` is
  dropped), referencing the built-in nodes by `@id`: `<site-home>#website` /
  `<site-home>#organization`, where the site home is the public origin plus
  any `basePath` (e.g. `https://acme.github.io/docs/#website`).
- `agent.llms.whenToUse: string[]` renders as `## When to use` under the
  llms.txt summary.
- `/sitemap.xml` now lists a dynamic route's real pages, not just static
  routes, and skips resource routes. At runtime those pages come from the
  route's `llms` entries (the runtime-safe hook `llms.txt` already runs);
  `staticPaths` stays build-only and is added only to the static() target's
  prerendered sitemap (outside i18n). `llms = false` keeps a static route in
  the sitemap; on a dynamic route it removes the route's pages from both
  llms.txt and the runtime sitemap (a static() build still lists them via
  `staticPaths`).
  `LlmsEntry.lastModified` (string or Date) becomes `<lastmod>`; June never
  fills in the build time.
