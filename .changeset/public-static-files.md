---
"@junejs/server": patch
---

Serve `public/` static files verbatim — dev and every deploy target.

Drop a file in the app-root `public/` directory and it is served at the matching
URL (`public/logo.svg` → `/logo.svg`), passthrough only: no content-hashing, no
optimization (that stays a future image service's job). Zero config.

- New `@junejs/server/static-files`: `contentTypeFor` (extension → MIME) and
  `safeRelativePath` (a pure, traversal-safe path cleaner — rejects `..`,
  backslashes, NUL, and malformed encoding). No `node:*`, so the worker bundle
  imports it too.
- Dev (`app.ts`): serves `public/` off disk before the render pipeline, so a
  public file shadows a same-path route exactly as it does when deployed.
- Build (`build.ts`): copies `public/**` into `dist/assets/**`, skipping the
  reserved `_june/` segment (framework assets) with a warning; the copied paths
  are threaded to adapters via a new `AdapterEmitContext.publicFiles`.
- Adapters: **Cloudflare** and **static** serve them via the whole-`assets/`
  tier (unchanged). **Vercel** places `publicFiles` on the Build Output `static/`
  tier (prerendered pages stay on the SSR function). **Deno** (`withDenoAssets`)
  now serves any co-located `assets/` file, not just `/_june/*`. Public files are
  `cache-control: must-revalidate` (not `immutable` — they are not hashed).

See `docs/static-files.md`.
