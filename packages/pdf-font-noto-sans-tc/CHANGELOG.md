# @junejs/pdf-font-noto-sans-tc

## 0.2.0

### Minor Changes

- [#378](https://github.com/junebuild/june/pull/378) [`9b5d420`](https://github.com/junebuild/june/commit/9b5d420f388ebf8e9c3b484a1ac1c5b2532603dc) Thanks [@linyiru](https://github.com/linyiru)! - New package: Noto Sans TC as an offline font provider for `@junejs/pdf-typst-wasm`, so Traditional Chinese PDFs render with no network call ([#368](https://github.com/junebuild/june/issues/368), [#371](https://github.com/junebuild/june/issues/371)).

  ```ts
  import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
  import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

  typstWasmRenderer({ fonts: [notoSansTC()] }); // renderer.egress: []
  ```

  - Ships Noto Sans CJK's Taiwan subset (Sans2.004, SIL Open Font License) in regular and bold, ~11 MB. That covers 17,755 Han characters, including every Big5 one. A rarer character still fails the render as a missing glyph. `notoSansTC({ weights: [400] })` reads and registers only the regular weight, which halves the font memory. A Worker upload or a compiled binary still carries both files.
  - Works on Node, Bun, Deno and Cloudflare Workers:
    - **Bun**: `bun build --compile` embeds the files.
    - **Workers**: they upload with the Worker as Data modules, about 40 of the 64 MiB limit together with the engine. Add `"rules": [{ "type": "Data", "globs": ["**/*.otf"] }]` to `wrangler.jsonc`.

### Patch Changes

- Updated dependencies [[`dbc95ff`](https://github.com/junebuild/june/commit/dbc95ffd548b0e4ea66bf5e86a14feff3e3c138a), [`a7001bb`](https://github.com/junebuild/june/commit/a7001bbbd545516fefe77bf0339d8d78c45fe887), [`a3d1f45`](https://github.com/junebuild/june/commit/a3d1f45f20ceaf2f617771bdba7b4401c20fd122), [`2e7d547`](https://github.com/junebuild/june/commit/2e7d547accb9776295a036579765aa37f6172bfe)]:
  - @junejs/pdf-typst-wasm@0.1.0

## 0.1.0-dev.0

### Minor Changes

- [#378](https://github.com/junebuild/june/pull/378) [`9b5d420`](https://github.com/junebuild/june/commit/9b5d420f388ebf8e9c3b484a1ac1c5b2532603dc) Thanks [@linyiru](https://github.com/linyiru)! - New package: Noto Sans TC as an offline font provider for `@junejs/pdf-typst-wasm`, so Traditional Chinese PDFs render with no network call ([#368](https://github.com/junebuild/june/issues/368), [#371](https://github.com/junebuild/june/issues/371)).

  ```ts
  import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
  import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

  typstWasmRenderer({ fonts: [notoSansTC()] }); // renderer.egress: []
  ```

  - Ships Noto Sans CJK's Taiwan subset (Sans2.004, SIL Open Font License) in regular and bold, ~11 MB. That covers 17,755 Han characters, including every Big5 one. A rarer character still fails the render as a missing glyph. `notoSansTC({ weights: [400] })` reads and registers only the regular weight, which halves the font memory. A Worker upload or a compiled binary still carries both files.
  - Works on Node, Bun, Deno and Cloudflare Workers:
    - **Bun**: `bun build --compile` embeds the files.
    - **Workers**: they upload with the Worker as Data modules, about 40 of the 64 MiB limit together with the engine. Add `"rules": [{ "type": "Data", "globs": ["**/*.otf"] }]` to `wrangler.jsonc`.

### Patch Changes

- Updated dependencies [[`a3d1f45`](https://github.com/junebuild/june/commit/a3d1f45f20ceaf2f617771bdba7b4401c20fd122)]:
  - @junejs/pdf-typst-wasm@0.1.0-dev.3
