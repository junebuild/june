---
"@junejs/server": patch
"@junejs/core": patch
---

Static builds no longer publish the placeholder prerender host (`https://prerender.june`) in `llms.txt` or `sitemap.xml` (#238).

- A prerendered discovery file now names the public origin: `site.url`'s origin, else `deploy.domain`, plus the deploy `basePath`. This is the same rule the agent catalogs already used, now shared (`publicOrigin`/`publicBase` in the pipeline), and it also covers robots.txt's `Sitemap:`/`Agentmap:` lines. A GitHub Pages project site's sitemap lists `https://user.github.io/repo/…`, and its hreflang alternates carry the subpath.
- With no public origin configured, `llms.txt` uses root-relative links (llmstxt.org allows them). `sitemap.xml`, whose protocol requires absolute URLs, is not written, and `june build` warns to set `site.url`.
- Live targets (Workers, Vercel, Deno) are unchanged: they keep using the request's own origin. A live site with a `basePath` now also gets the subpath in these files.
- The page head's `<link rel="alternate" hreflang>` links now carry the deploy `basePath`, like the canonical link and the sitemap. On a basePath site they used to point at `/de/about` instead of `/base/de/about`, a 404 that disagreed with the sitemap.
- A `static()` build with an i18n locale on its own `domain` now fails with a clear message. One file tree serves one host, so give that locale a path prefix. It used to die with `prerender https://<domain>/ → 404`.
