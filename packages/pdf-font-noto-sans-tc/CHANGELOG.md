# @junejs/pdf-font-noto-sans-tc

## 0.2.2

### Patch Changes

- Updated dependencies []:
  - @junejs/pdf-typst-wasm@0.2.2

## 0.2.1

### Patch Changes

- [#388](https://github.com/junebuild/june/pull/388) [`b9a3c06`](https://github.com/junebuild/june/commit/b9a3c06e0a58aed55479c12a00162e19eab23bd5) Thanks [@linyiru](https://github.com/linyiru)! - New `unbundled` entries keep the PDF engine and fonts out of a `bun build --compile` binary until it renders ([#383](https://github.com/junebuild/june/issues/383)). The default entries embed `typst.wasm` (29 MiB) and Noto Sans TC (~11 MiB) as soon as the app imports them. For an app where PDF output is optional, most installs carry 40 MiB they never load.

  ```ts
  import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc/unbundled";
  import {
    typstWasmRenderer,
    type AssetRef,
  } from "@junejs/pdf-typst-wasm/unbundled";

  const load = (ref: AssetRef) => readFile(`/data/june-assets/${ref.name}`); // or download from ref.urls
  const renderer = typstWasmRenderer({ load, fonts: [notoSansTC({ load })] });
  ```

  - The entries reference no files. `load` is called on the first render with each file's ref: `{ name, size, sha256, urls }`.
  - The package checks the bytes against the ref's size and SHA-256 before using them (`loadVerified`). A loader that just downloads is as safe as a careful one.
  - The engine's ref is generated at build from the file being published. Its URLs are the release's own file on jsDelivr and unpkg. The fonts point at their upstream Noto tag.
  - `renderer.egress` lists those hosts with `sends: "nothing"`. Pass `engineEgress: []` / `egress: []` when you pre-seed the files.
  - Measured (Bun 1.4.2, macOS arm64): 59.4 MiB with the unbundled entries, against 59.3 MiB for the Bun runtime alone and 99.8 MiB with the default entries.
  - The default entries are unchanged. `loadVerified` and `AssetRef` are also exported from `@junejs/pdf-typst-wasm`, to pin your own font files.

- Updated dependencies [[`b9a3c06`](https://github.com/junebuild/june/commit/b9a3c06e0a58aed55479c12a00162e19eab23bd5)]:
  - @junejs/pdf-typst-wasm@0.2.1

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
