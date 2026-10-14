# @junejs/pdf-typst-wasm

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

- Updated dependencies []:
  - @junejs/pdf@0.2.1

## 0.2.0

### Minor Changes

- [#374](https://github.com/junebuild/june/pull/374) [`dbc95ff`](https://github.com/junebuild/june/commit/dbc95ffd548b0e4ea66bf5e86a14feff3e3c138a) Thanks [@linyiru](https://github.com/linyiru)! - Fonts are now providers, and the default renders offline ([#371](https://github.com/junebuild/june/issues/371)). Before, every document with non-ASCII text sent those characters to fonts.googleapis.com unless you knew to turn it off. Now the renderer makes no network call unless you add a provider that does, and each provider declares what it sends where.

  ```ts
  import {
    googleFontSubsets,
    localFonts,
    typstWasmRenderer,
  } from "@junejs/pdf-typst-wasm";

  typstWasmRenderer(); // offline: Typst's built-in fonts
  typstWasmRenderer({ fonts: [localFonts([notoSansTcBytes])] }); // offline, with your CJK font
  typstWasmRenderer({
    fonts: [
      googleFontSubsets({
        families: [{ family: "Noto Sans TC", weights: [400, 700] }],
      }),
    ],
  });
  ```

  - `renderer.egress` lists each host the configured fonts contact and whether it receives the document's characters. It is `[]` when the renderer works offline. Show it in a setup check or your docs.
  - A character no font covers fails the render with a `PdfRenderError` (see the previous change), so going offline can't silently produce blank text.
  - Write your own provider: `{ name, egress, persistent?(), forDocument?(text) }`. `persistent()` returns font files; `forDocument(text)` returns `{ fonts, failed? }`, so a partial failure keeps the fonts that loaded.

  **Migrating:**

  - **You relied on the default for Chinese.** Add `fonts: [googleFontSubsets({ families: [{ family: "Noto Sans TC", weights: [400, 700] }] })]` to keep the old behavior. Otherwise a CJK document now fails with an error naming the missing characters.
  - `googleFonts: [...]` → `fonts: [googleFontSubsets({ families: [...] })]`.
  - `googleFonts: false` → remove it; offline is the default.
  - `fonts: [bytes, url, loader]` → `fonts: [localFonts([bytes, url, loader])]`.
  - `fetch` moved from the renderer to the provider that fetches: `googleFontSubsets({ families, fetch })`, `localFonts(sources, { fetch })`.
  - `DEFAULT_GOOGLE_FONTS` is removed.

- [#372](https://github.com/junebuild/june/pull/372) [`a7001bb`](https://github.com/junebuild/june/commit/a7001bbbd545516fefe77bf0339d8d78c45fe887) Thanks [@linyiru](https://github.com/linyiru)! - Characters no loaded font covers are now an error instead of blanks in the PDF ([#368](https://github.com/junebuild/june/issues/368)). Before, a CJK document with `googleFonts: false`, or one whose Google Fonts fetch failed, came out with those characters silently missing; an emoji did the same.

  - `render` throws a `PdfRenderError` naming the characters (the first ten, then a count) and any font that failed to fetch. `render_pdf` hands it to the model, which can drop a decorative emoji or tell the user.
  - To keep the old behavior, pass `onMissingGlyphs: "warn"`: the PDF renders with those characters blank and the message is logged.
  - A font that fails to fetch no longer logs a warning by itself. It shows up in the error only when its characters end up uncovered.
  - **Breaking, for code that drives the engine directly:** `TypstEngine.compile` returns `{ pdf, missingGlyphs }` instead of the PDF bytes. Migrate with `engine.compile(source).pdf`.

- [#363](https://github.com/junebuild/june/pull/363) [`2e7d547`](https://github.com/junebuild/june/commit/2e7d547accb9776295a036579765aa37f6172bfe) Thanks [@linyiru](https://github.com/linyiru)! - New package: a `PdfRenderer` on a Typst → PDF engine compiled to WebAssembly, for `@junejs/pdf`'s `render_pdf`. It needs no browser and no native binary, and it runs on Cloudflare Workers as well as Node, Bun and Deno.

  ```ts
  // agent/tools/pdf.ts
  import { pdfTools } from "@junejs/pdf";
  import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

  export default pdfTools({ renderer: typstWasmRenderer() });
  ```

  - **Only Typst and its PDF export**, without typst.ts's editor features or JS glue. The module (29 MiB, zero imports) is well within Workers' 64 MiB size limit. On Workers it is imported, so it uploads precompiled. Measured on a deployed Worker: 2 ms startup, ~40 ms of CPU for a warm one-page render, ~670 ms for 18 pages. **Use Workers Paid**: the Free plan's 10 ms of CPU is not enough.
  - **One engine per process or isolate**, created on the first render. On Workers an isolate's requests share 128 MB of memory.
  - **Fonts**:
    - Typst's own fonts are built in (Libertinus Serif, New Computer Modern, DejaVu Sans Mono).
    - `fonts` registers yours once.
    - Per document, the engine fetches **Noto Sans TC** subsets from Google Fonts covering just that document's non-ASCII characters, so Traditional Chinese works with no setup. Choose other families with `googleFonts: [{ family, weights }]`, or turn the fetch off with `googleFonts: false`.
    - If a font can't be fetched, its characters render blank and the document still renders.
  - Typst errors become `PdfRenderError`s that `render_pdf` hands to the model.

### Patch Changes

- [#376](https://github.com/junebuild/june/pull/376) [`a3d1f45`](https://github.com/junebuild/june/commit/a3d1f45f20ceaf2f617771bdba7b4401c20fd122) Thanks [@linyiru](https://github.com/linyiru)! - `bun build --compile` now embeds the engine, so a single-file binary renders PDFs with no configuration ([#367](https://github.com/junebuild/june/issues/367)). Before, the binary was built without `typst.wasm`, and the first `render_pdf` failed with a message telling you to build the June repo. On Bun the package now imports the module `with { type: "file" }`, which the bundler sees. It is still loaded only on the first render.

  If you worked around this by passing `wasm` yourself, you can remove that option. On Node, the missing-module error now also points single-file builds to the `wasm` option.

- Updated dependencies [[`3b94181`](https://github.com/junebuild/june/commit/3b94181c9af4e1054dddff7343f9267807ffa65e), [`0fff693`](https://github.com/junebuild/june/commit/0fff693466caa15098c985fed9883626f3a4970a), [`50783bd`](https://github.com/junebuild/june/commit/50783bdb306bc648852197a2319533ff1c05b477)]:
  - @junejs/pdf@0.1.0

## 0.1.0-dev.3

### Patch Changes

- [#376](https://github.com/junebuild/june/pull/376) [`a3d1f45`](https://github.com/junebuild/june/commit/a3d1f45f20ceaf2f617771bdba7b4401c20fd122) Thanks [@linyiru](https://github.com/linyiru)! - `bun build --compile` now embeds the engine, so a single-file binary renders PDFs with no configuration ([#367](https://github.com/junebuild/june/issues/367)). Before, the binary was built without `typst.wasm`, and the first `render_pdf` failed with a message telling you to build the June repo. On Bun the package now imports the module `with { type: "file" }`, which the bundler sees. It is still loaded only on the first render.

  If you worked around this by passing `wasm` yourself, you can remove that option. On Node, the missing-module error now also points single-file builds to the `wasm` option.

## 0.1.0-dev.2

### Minor Changes

- [#374](https://github.com/junebuild/june/pull/374) [`dbc95ff`](https://github.com/junebuild/june/commit/dbc95ffd548b0e4ea66bf5e86a14feff3e3c138a) Thanks [@linyiru](https://github.com/linyiru)! - Fonts are now providers, and the default renders offline ([#371](https://github.com/junebuild/june/issues/371)). Before, every document with non-ASCII text sent those characters to fonts.googleapis.com unless you knew to turn it off. Now the renderer makes no network call unless you add a provider that does, and each provider declares what it sends where.

  ```ts
  import {
    googleFontSubsets,
    localFonts,
    typstWasmRenderer,
  } from "@junejs/pdf-typst-wasm";

  typstWasmRenderer(); // offline: Typst's built-in fonts
  typstWasmRenderer({ fonts: [localFonts([notoSansTcBytes])] }); // offline, with your CJK font
  typstWasmRenderer({
    fonts: [
      googleFontSubsets({
        families: [{ family: "Noto Sans TC", weights: [400, 700] }],
      }),
    ],
  });
  ```

  - `renderer.egress` lists each host the configured fonts contact and whether it receives the document's characters. It is `[]` when the renderer works offline. Show it in a setup check or your docs.
  - A character no font covers fails the render with a `PdfRenderError` (see the previous change), so going offline can't silently produce blank text.
  - Write your own provider: `{ name, egress, persistent?(), forDocument?(text) }`. `persistent()` returns font files; `forDocument(text)` returns `{ fonts, failed? }`, so a partial failure keeps the fonts that loaded.

  **Migrating:**

  - **You relied on the default for Chinese.** Add `fonts: [googleFontSubsets({ families: [{ family: "Noto Sans TC", weights: [400, 700] }] })]` to keep the old behavior. Otherwise a CJK document now fails with an error naming the missing characters.
  - `googleFonts: [...]` → `fonts: [googleFontSubsets({ families: [...] })]`.
  - `googleFonts: false` → remove it; offline is the default.
  - `fonts: [bytes, url, loader]` → `fonts: [localFonts([bytes, url, loader])]`.
  - `fetch` moved from the renderer to the provider that fetches: `googleFontSubsets({ families, fetch })`, `localFonts(sources, { fetch })`.
  - `DEFAULT_GOOGLE_FONTS` is removed.

### Patch Changes

- Updated dependencies [[`3b94181`](https://github.com/junebuild/june/commit/3b94181c9af4e1054dddff7343f9267807ffa65e)]:
  - @junejs/pdf@0.1.0-dev.2

## 0.1.0-dev.1

### Minor Changes

- [#372](https://github.com/junebuild/june/pull/372) [`a7001bb`](https://github.com/junebuild/june/commit/a7001bbbd545516fefe77bf0339d8d78c45fe887) Thanks [@linyiru](https://github.com/linyiru)! - Characters no loaded font covers are now an error instead of blanks in the PDF ([#368](https://github.com/junebuild/june/issues/368)). Before, a CJK document with `googleFonts: false`, or one whose Google Fonts fetch failed, came out with those characters silently missing; an emoji did the same.

  - `render` throws a `PdfRenderError` naming the characters (the first ten, then a count) and any font that failed to fetch. `render_pdf` hands it to the model, which can drop a decorative emoji or tell the user.
  - To keep the old behavior, pass `onMissingGlyphs: "warn"`: the PDF renders with those characters blank and the message is logged.
  - A font that fails to fetch no longer logs a warning by itself. It shows up in the error only when its characters end up uncovered.
  - **Breaking, for code that drives the engine directly:** `TypstEngine.compile` returns `{ pdf, missingGlyphs }` instead of the PDF bytes. Migrate with `engine.compile(source).pdf`.

## 0.1.0-dev.0

### Minor Changes

- [#363](https://github.com/junebuild/june/pull/363) [`2e7d547`](https://github.com/junebuild/june/commit/2e7d547accb9776295a036579765aa37f6172bfe) Thanks [@linyiru](https://github.com/linyiru)! - New package: a `PdfRenderer` on a Typst → PDF engine compiled to WebAssembly, for `@junejs/pdf`'s `render_pdf`. It needs no browser and no native binary, and it runs on Cloudflare Workers as well as Node, Bun and Deno.

  ```ts
  // agent/tools/pdf.ts
  import { pdfTools } from "@junejs/pdf";
  import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

  export default pdfTools({ renderer: typstWasmRenderer() });
  ```

  - **Only Typst and its PDF export**, without typst.ts's editor features or JS glue. The module (29 MiB, zero imports) is well within Workers' 64 MiB size limit. On Workers it is imported, so it uploads precompiled. Measured on a deployed Worker: 2 ms startup, ~40 ms of CPU for a warm one-page render, ~670 ms for 18 pages. **Use Workers Paid**: the Free plan's 10 ms of CPU is not enough.
  - **One engine per process or isolate**, created on the first render. On Workers an isolate's requests share 128 MB of memory.
  - **Fonts**:
    - Typst's own fonts are built in (Libertinus Serif, New Computer Modern, DejaVu Sans Mono).
    - `fonts` registers yours once.
    - Per document, the engine fetches **Noto Sans TC** subsets from Google Fonts covering just that document's non-ASCII characters, so Traditional Chinese works with no setup. Choose other families with `googleFonts: [{ family, weights }]`, or turn the fetch off with `googleFonts: false`.
    - If a font can't be fetched, its characters render blank and the document still renders.
  - Typst errors become `PdfRenderError`s that `render_pdf` hands to the model.

### Patch Changes

- Updated dependencies [[`50783bd`](https://github.com/junebuild/june/commit/50783bdb306bc648852197a2319533ff1c05b477)]:
  - @junejs/pdf@0.1.0-dev.1
