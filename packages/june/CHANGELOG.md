# @junejs/server

## 0.0.52

### Patch Changes

- [#20](https://github.com/junebuild/june/pull/20) [`4f6d26a`](https://github.com/junebuild/june/commit/4f6d26ac011d3121f6c6533712b31462c623c19a) Thanks [@linyiru](https://github.com/linyiru)! - Silence two spurious build warnings

  - `CONFIGURATION_FIELD_CONFLICT` no longer fires when the app's tsconfig declares
    `jsxImportSource: "@junejs/core"`: the v0.0.41 skip only covered the worker bundle — the
    CLIENT bundle still set `transform.jsx.importSource` unconditionally. Both passes now share
    one `jsxTransform` helper. The tsconfig reader is also JSONC-tolerant now (comments and
    trailing commas are idiomatic tsconfig; a strict-parse failure silently regressed to
    "not declared" and brought the warning back).
  - `UNRESOLVED_IMPORT react-server-dom-webpack/client.browser` no longer prints on every client
    bundle. That dynamic import (client-router-flight's decoder) is intentionally optional: morph
    apps don't install it, the runtime `import()` rejects, and the navigation hard-falls-back by
    design. The client bundle's `onLog` now silences exactly that log — real unresolved imports
    still warn.

## 0.0.51

### Patch Changes

- [#18](https://github.com/junebuild/june/pull/18) [`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c) Thanks [@linyiru](https://github.com/linyiru)! - Configurable content sources: `content.sources` in june.config.ts

  Content no longer has to live under `content/<collection>/`. Config can declare extra source
  directories — including ones outside the app root — that merge into named collections:

  ```ts
  export default defineJune({
    content: {
      sources: [
        { dir: "../docs", collection: "docs" }, // the repo's own docs/, docs-as-code
        { dir: "../schema", collection: "docs", mount: "schema" }, // slugs prefixed schema/…
      ],
    },
  });
  ```

  - Each source scans with the same locale-mirror layout as `content/` (`<dir>/<locale>/…`).
  - `mount` prefixes slugs; a source's root `index.md`/`README.md` becomes the mount's page.
  - A slug collision between sources fails `june gen` loudly, naming both files. A missing
    configured dir is a build error, not a silent skip.
  - Bootstrap-safe: a wrapper-generated config that imports `app/_content.ts` (which only exists
    AFTER the first freeze) self-heals — `june gen` generates the default scan, re-probes the
    config in a fresh subprocess, and regenerates with the sources applied.
  - `june dev` watches configured source dirs (they're outside the app root, invisible to the
    root watcher) and regenerates + restarts on change.

- Updated dependencies [[`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c)]:
  - @junejs/core@0.0.48

## 0.0.50

### Patch Changes

- [#14](https://github.com/junebuild/june/pull/14) [`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8) Thanks [@linyiru](https://github.com/linyiru)! - fix(client-router): percent-encode the soft-nav title header (non-ASCII titles no longer 500)

  The `fragment` projection put the page title verbatim into the `x-june-title`
  header. HTTP header values are ByteStrings (Latin-1, ≤0xFF), so a non-ASCII
  title — CJK, accents, emoji — threw `TypeError: Cannot convert argument to a
ByteString` at `headers.set`, crashing the whole fragment render with a 500. The
  client router then hit its hard-navigation fallback, so every soft nav to a
  non-ASCII-titled page became a full document reload — the white flash
  `clientRouter` exists to remove (the failure on Node/undici runtimes like
  Vercel's serverless functions; only ASCII-titled pages soft-navigated).

  The server now `encodeURIComponent`s the title before `headers.set`, and the
  three client consumers (morph router, flight router, dev live-reload) decode it
  back with `decodeURIComponent` before assigning `document.title`. ASCII titles
  are unchanged on the wire (`encodeURIComponent("Home") === "Home"`).

- Updated dependencies [[`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8)]:
  - @junejs/core@0.0.47

## 0.0.49

### Patch Changes

- [#12](https://github.com/junebuild/june/pull/12) [`bc16ba0`](https://github.com/junebuild/june/commit/bc16ba058a05de952691ebca6a78ce36b3e8dd4d) Thanks [@linyiru](https://github.com/linyiru)! - fix(build): lazy-load oxc-parser in the island registry so it stays out of the runtime bundle

  `island-registry.ts` imported `parseSync` from `oxc-parser` at module top level. oxc-parser eagerly loads a native/wasm binding on import, and `rsc-manifest.ts` (reachable from the runtime worker) pulls this module in for its lightweight helpers (`walk`, `exportNames`, `firstStatementIsDirective`) — none of which need oxc. That dragged oxc-parser's binding into the worker bundle, crashing targets that don't ship it: a Vercel Node function failed with `Cannot find package '@oxc-parser/binding-wasm32-wasi'` (`FUNCTION_INVOCATION_FAILED`). The Workers bundle tree-shakes the chain differently and was unaffected.

  `oxc-parser` is now dynamic-imported inside `generateIslandRegistry` (its only consumer, which runs at build time only). The function becomes async; its two build-time call sites (`build.ts`, `app.ts`) await it.

## 0.0.48

### Patch Changes

- [#10](https://github.com/junebuild/june/pull/10) [`b83df35`](https://github.com/junebuild/june/commit/b83df356771e44818004562640f7e7ff4e476c6d) Thanks [@linyiru](https://github.com/linyiru)! - Render content markdown with @momiji-rs/sparkdown/gfm (wasm) instead of marked

  The content pipeline now renders `entry.html` via `@momiji-rs/sparkdown/gfm` — a WASI-free WebAssembly
  CommonMark + GFM renderer — replacing `marked`. Benchmarked on real docs (Bun): ~75× faster on small
  pages and ~580× faster on large pages (marked degrades super-linearly: a 27KB page took ~130ms; the
  same page renders in ~0.22ms), with GFM (tables, strikethrough, task lists, autolinks) at no extra
  cost. Output is CommonMark-strict: headings stay bare (`<h2>…`), code fences keep `language-*`, and a
  bare `{…}` is literal text. The wasm initializes once per process; this module is build/dev-only, so it
  never enters the worker bundle.
