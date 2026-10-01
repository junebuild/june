# @junejs/og

## 0.0.7-dev.0

### Patch Changes

- [#326](https://github.com/junebuild/june/pull/326) [`44ef16b`](https://github.com/junebuild/june/commit/44ef16bd8064a7e6c81e4642562bf579e11ed6d1) Thanks [@linyiru](https://github.com/linyiru)! - `ImageResponse` now answers with one `Content-Type` and one `Cache-Control` on every backend, whatever casing the caller's header names use.

  On Workers, `headers: OG_HEADERS` sent `Content-Type: image/png, image/png` and a `Cache-Control` that joined workers-og's year-long immutable default with the caller's `max-age=86400`: workers-og stores its defaults under title-case keys and then spreads the caller's headers, so the lowercase keys became second entries and `Headers` appended both. The Workers backend now builds the response itself and lets workers-og render the body only. With `debug: true`, Workers no longer switches `Cache-Control` to `no-cache, no-store`; pass `headers: { "cache-control": "no-store" }` for that.

  On Node and edge the same thing happened the other way round: a title-case `Cache-Control` or `Content-Type` from the caller joined the lowercase defaults instead of replacing them. All three backends now merge headers case-insensitively and set `content-type: image/png` last.

## 0.0.6

### Patch Changes

- [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
  them too.

  Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
  `@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
  `dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
  `source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
  bundlers), while `default`/`types` serve built JS + declarations for Node and
  external `tsc`. Notes per package:

  - `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
    `default` each map to the right built entry; the OG renderers (`workers-og`,
    `@vercel/og`) stay external so their WASM is never bundled.
  - `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
    runs `src/june.ts` raw under Bun.

  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
  workspace.

## 0.0.6-dev.0

### Patch Changes

- [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
  them too.

  Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
  `@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
  `dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
  `source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
  bundlers), while `default`/`types` serve built JS + declarations for Node and
  external `tsc`. Notes per package:

  - `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
    `default` each map to the right built entry; the OG renderers (`workers-og`,
    `@vercel/og`) stay external so their WASM is never bundled.
  - `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
    runs `src/june.ts` raw under Bun.

  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
  workspace.

## 0.0.5

### Patch Changes

- [#16](https://github.com/junebuild/june/pull/16) [`56668a4`](https://github.com/junebuild/june/commit/56668a47075ff5deeafdf460136b07649378a736) Thanks [@linyiru](https://github.com/linyiru)! - fix(og): lazy-load @vercel/og in the edge backend so the worker bundles without it

  `edge.ts` (the `edge-light` condition, used by the vercel target) did a STATIC
  `export { ImageResponse } from "@vercel/og"`. @vercel/og's entry statically imports
  `./yoga.wasm?module`, which rolldown — June's worker bundler — can't bundle, so EVERY
  worker carrying the OG route failed to build, even when OG is prerendered to static files
  and @vercel/og is never called at runtime. Externalizing doesn't help: an ESM static
  import is resolved at module load regardless of use (so consumers had to ship a throwing
  @vercel/og stub just to get a clean bundle).

  The edge backend now loads @vercel/og lazily via `new Function("return import(m)")` —
  the same pattern node.ts already uses for satori/@resvg/resvg-js — so the bundler never
  resolves it at build time. Edge/Node OG still renders at runtime (the consumer installs
  @vercel/og; it's piped through unchanged), and a static-prerendered route, never invoked,
  pulls nothing. Removes the need for the @vercel/og bundling stub on the vercel target.
