---
title: "OG images, typeset at the edge"
nav: "OG Image"
description: Social cards as a route that returns a PNG — satori + resvg in the worker, with runtime font subsetting so CJK titles work.
date: 2026-06-12
section: Features
order: "31"
---
## The feature

An og:image should not be a pre-generated file you forget to regenerate — it
is a route. This site serves `/og/<slug>.png` from the worker for EVERY page
(posts, docs, core pages), and each page's `og:image` meta tag points at its
own card. This page's, rendered live as you read:

![The social card for this very page, typeset at request time](/og/features-og-image.png)

```
/og/<slug>.png → detect CJK → fetch font subset (text=title) → satori → resvg → PNG
```

satori lays out JSX inside the V8 isolate; resvg (Rust compiled to WASM)
rasterizes it. No browser, no puppeteer fleet — it runs where the rest of
your app runs.

## The CJK part

Full CJK families (Noto Sans TC / SC / JP / KR) weigh several MB per script —
far too heavy to ship in a worker, and a build can't know the glyph set of a
dynamic title ahead of time. The answer is runtime subsetting via Google
Fonts' `text=` parameter: download only the glyphs the title actually uses
(a few dozen KB), cache the subset for a week through workerd's Cache API.
Traditional and Simplified Chinese resolve to different fonts; Japanese mixes
kana with its own kanji forms — the detection step picks per title.

The full design walkthrough, with per-script samples, is in
[Typesetting CJK at the edge](/blog/2026-06-10-typesetting-cjk-at-the-edge).

## Try it

```bash
curl -o card.png https://june.build/og/2026-06-10-typesetting-cjk-at-the-edge.png
```

The route lives behind `app/_extra.tsx` — June's pre-route escape hatch for
responses a page has no projection for yet (binary bodies). One card
definition renders everywhere: workers-og rasterizes it on workerd, satori +
resvg-js rasterize the same JSX on the dev host — so the social card you
preview at `localhost:3000/og/…` is the one that deploys.

## The tags around it

Every page gets the social tags without asking — no `openGraph` metadata
needed for a link to unfurl as a card:

- `og:title`, `og:description`, `og:type`, `og:site_name`, `og:locale` — from
  the page's title and description, `site.name`, and the document language.
- `og:url` and `<link rel="canonical">` — the page's URL without its query
  string. `metadata.canonical` overrides it; `noindex` pages get none.
- `twitter:card` — `summary_large_image` when the page has an image, else
  `summary`. `site.twitter` adds `twitter:site`.
- JSON-LD on the homepage, including a locale's home (`/de`): a schema.org
  `@graph` with the `WebSite`. See [Who runs the site](#who-runs-the-site).
- `theme-color` (the mobile toolbar colour) from `site.themeColor`: one colour,
  or `{ light, dark }` for a page that follows the system scheme. Unset, June
  uses its starter background only when the starter look is the page's whole
  look (no `global.css`, no CSS Modules). Otherwise it can't know your
  background, so it emits no tag rather than guess.

The public origin is `site.url`, else `https://<deploy.domain>`, else the
request's own origin. A page served on an i18n locale's own domain
(`fr: { domain: "example.fr" }`) always uses that domain. Pages `june build`
prerenders have no real request, so they need `site.url` or `deploy.domain` for
their absolute URLs. Without either, June leaves those tags out rather than
emitting wrong ones. A root-relative image resolves against the origin, or is
left out when there is none:

```ts
export const metadata = {
  title: "Pricing",
  openGraph: { image: "/og/pricing.png", imageWidth: 1200, imageHeight: 630 },
};
```

`imageAlt` defaults to the og:title; set `imageWidth`/`imageHeight` so
unfurlers can lay the card out before the PNG arrives.

## Who runs the site

Search engines and agents check a site's structured data to tell it apart
from lookalikes before they cite or recommend it. June can't know who runs
your site, so it emits the `WebSite` node alone until you say. Add
`site.organization` and the homepage's `@graph` gains an `Organization`, which
the `WebSite` names as its publisher:

```ts
// june.config.ts
export default defineJune({
  site: {
    name: "Acme",
    twitter: "@acme",
    organization: {
      email: "support@acme.com",
      sameAs: ["https://github.com/acme", "https://www.linkedin.com/company/acme"],
    },
  },
});
```

- `name` defaults to `site.name`, `url` to the public origin, and `logo` to
  `site.icon`. Relative URLs resolve against the origin.
- `email` and `telephone` become a `ContactPoint`
  (`contactType: "customer support"`). `address` becomes a `PostalAddress`.
  There's no address unless you give one.
- `sameAs` lists your official profiles. June adds your `site.twitter`
  handle's profile URL for you.

To say what the site is (a `SoftwareApplication`, a `Product`, an `FAQPage`),
add nodes with `site.jsonLd`. They're appended to the same `@graph`. A node's
own top-level `@context` is dropped, because the graph already carries one.
They can point at the built-in nodes by `@id`: `<site-home>#website` and
`<site-home>#organization`. The site home is the public origin plus any
`basePath`, for example `https://acme.github.io/docs/#organization`.

```ts
site: {
  jsonLd: {
    "@type": "SoftwareApplication",
    name: "Acme CLI",
    applicationCategory: "DeveloperApplication",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": "https://acme.com/#organization" },
  },
},
```

## Why it matters

Social cards are the page most teams generate with a headless browser in a
cron job. Making them a route means they're always current, deploy with the
app, and cost a font subset — not a Chromium.
