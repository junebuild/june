# @junejs/server

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
