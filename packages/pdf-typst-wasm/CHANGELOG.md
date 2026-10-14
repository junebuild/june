# @junejs/pdf-typst-wasm

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
