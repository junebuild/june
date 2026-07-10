# Static files — the `public/` directory (v0.1)

> Added 2026-07-09. Drop a file in `public/` and it is served verbatim at the
> matching URL — on `june dev` and on every deploy target. Passthrough ONLY: no
> content-hashing, no format conversion, no optimization. That last part is a
> deliberate seam for a future image service (see the end of this doc).

## The convention

`public/` sits at the app root, a sibling of `app/`:

```
my-app/
  app/            # routes
  public/         # static files, served verbatim
    logo.svg      →  /logo.svg
    images/
      hero.png    →  /images/hero.png
    favicon.ico   →  /favicon.ico
```

Zero config. There is no `publicDir` option — the folder is `public/`, full stop.
A file at `public/<path>` is served at `/<path>` with a content-type inferred
from its extension (unknown extension → `application/octet-stream`).

## Precedence: `public/` answers before your routes

A static file is checked **before** the render pipeline, so `public/robots.txt`
wins over the framework's generated `robots.txt`, and `public/favicon.ico` wins
over the auto-generated letter favicon. This mirrors production exactly:

| Target | Who serves `public/` files | Mechanism |
|---|---|---|
| `june dev` | the dev host (`app.ts`) | reads the file off disk before the pipeline |
| **Cloudflare Workers** | the platform | the `ASSETS` binding (`run_worker_first`) answers before the worker's pipeline |
| **Vercel** | the platform CDN | copied to the Build Output `static/` tier, served by the `filesystem` route handle |
| **Deno Deploy** | the server, in-process | `withDenoAssets` reads the co-located `assets/` dir before the pipeline |
| **Static (SSG)** | the file host | the whole `assets/` tree publishes to `dist/static/` |

Because the check is "file exists → serve it," a `public/` file whose path
collides with a route shadows that route. That is the intended, cross-target
behavior — name your files deliberately.

## What the build does

`june build` copies `public/**` into `dist/assets/**` (verbatim), and each adapter
places them on its target's static tier. Public files are **not** content-hashed,
so they are served `cache-control: public, max-age=0, must-revalidate` — the
browser revalidates rather than caching forever (only hashed framework assets
under `_june/` are `immutable`).

## `_june/` is reserved

The framework owns the `_june/` URL segment (the hashed client bundle and CSS
live there). A file under `public/_june/` is **ignored** — the build skips it with
a warning so a user file can never overwrite a framework asset. Put your files
anywhere else.

## Not in scope: optimization

`public/` is passthrough by design. It does **not** hash filenames, generate
`srcset`, convert to AVIF/WebP, or resize. Those belong to a future **image
service** — a swappable seam (like `@junejs/og`'s build-time backend selection)
that maps to the deploy target: Cloudflare Image Resizing at the edge, Vercel
Image Optimization, or WASM/sharp for SSG and dev. Until that lands, `public/` is
the right home for images you want served as-is, and a resource route
(`app/**/route.ts` returning an image `Response`) is the escape hatch for
anything dynamic.
