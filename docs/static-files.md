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

## Default icons

An app with no icon of its own gets a full set, drawn from the first character
of `site.name` on a dark square:

| File | For |
|---|---|
| `/favicon.svg` | browser tabs (served by the pipeline, no build step) |
| `/icon.png` (32×32) | Google Search, which doesn't show SVG favicons |
| `/apple-touch-icon.png` (180×180) | iOS home screens (full-bleed; iOS rounds the corners) |
| `/favicon.ico` | anything that requests it directly |
| `/icon-192.png`, `/icon-512.png` | the web manifest (Android home screens) |
| `/manifest.webmanifest` | Android "Add to Home Screen" (served by the pipeline) |

`june build` rasterizes the PNGs and ICO into `dist/assets/`, and `june dev`
renders them on first request with the same code, so they match byte for byte.
The document links `favicon.svg`, `icon.png`, `apple-touch-icon.png`, and the
manifest. `favicon.ico` has no `<link>`: it is there for clients that request
`/favicon.ico` by convention.

The manifest carries `site.name`, a short name (`site.shortName`, else the part
of the name before " — ", " | ", or ": "), `site.description`, the 192/512
icons (the 512 is also marked `maskable`, since the glyph stays inside the
safe zone), and the theme colour when there is a single one. `display` is
`browser`: a home-screen shortcut that opens a normal tab. For an app-like
`standalone` launch, ship your own `public/manifest.webmanifest` (or
`manifest.json`); June links it instead and generates none. June also generates
no manifest when the app brings its own icons, because there are no 192/512
PNGs for it to point at.

A rasterizer has no browser fonts, so the font follows the character's script:

- **Latin, Greek, Cyrillic, digits**: Inter, bundled with June. Needs no network,
  and every build renders the same bytes.
- **Han**: the Noto Sans CJK face whose glyph forms match `site.lang`, resolved
  through CLDR likely subtags. `zh`/`zh-CN` → SC, `zh-TW`/`zh-Hant` → TC,
  `zh-HK`/`yue` → HK, `ja` → JP, `ko` → KR. A `lang` with no Han signal (`en`)
  gets SC, CLDR's default for Han. **Set `site.lang` to get the right forms.**
- **Kana** → Noto Sans JP · **Hangul** → Noto Sans KR · **emoji** → Noto Emoji ·
  **Arabic, Devanagari, Thai, Hebrew, …** → that script's Noto Sans face.

Non-bundled faces are fetched from Google Fonts subset to that one character (a
few KB) and cached in `node_modules/.cache/june/fonts`, so only the first build
needs the network. If the fetch fails (offline) or the script has no known face,
the square is drawn without a character and the build prints a warning. It never
fails the build.

To use your own, set `site.icon` or put any of `favicon.ico`, `favicon.svg`,
`favicon.png`, `icon.png`, `icon.svg`, `apple-touch-icon.png` in `public/`. June
then generates nothing and links yours instead. The favicon link goes to the
first present of `favicon.svg`, `icon.svg`, `favicon.png`,
`icon.png`, `favicon.ico` (`site.icon` overrides it), and `icon.png` and
`apple-touch-icon.png` get their own links.

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
