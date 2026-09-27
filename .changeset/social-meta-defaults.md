---
"@junejs/core": patch
"@junejs/server": patch
---

Every page now ships the social and SEO tags a link preview needs, with no metadata required. Before, the document emitted OpenGraph tags only when a route set `openGraph`, and never `og:url`, `og:site_name`, `og:locale`, `twitter:card`, or a default canonical, so opengraph.to scored june.build 40. Now `og:title`/`og:description`/`og:type`/`og:site_name`/`og:locale` are always present; `og:url` and `<link rel="canonical">` default to the page URL without its query string (`metadata.canonical` overrides it; `noindex` pages get none); `twitter:card` is `summary_large_image` when there is an image, else `summary`; and the homepage carries WebSite JSON-LD.

Absolute URLs use the public origin: an i18n locale's own domain for its pages, else a new `site.url`, else `https://<deploy.domain>`, else the request origin. The `june build` prerender host is never used. With no public origin, the URL-derived tags are omitted, and a root-relative `openGraph.image` resolves against the origin or is dropped. Homepage detection uses the matched route, so a locale home (`/de`) and `/index` count, and RSC pages get the same tags. New optional fields: `site.twitter` (→ `twitter:site`), `openGraph.imageAlt`/`imageWidth`/`imageHeight`, and `metadata.twitter.card`/`creator`.
