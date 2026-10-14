---
"@junejs/pdf": minor
---

`typstRenderer` and the `@junejs/pdf/typst` entry are removed, along with the optional `@myriaddreamin/typst.ts` peer dependencies. Use `@junejs/pdf-typst-wasm`. It typesets the same Markdown into the same layout, runs on Node, Bun, Deno and Cloudflare Workers, renders Latin text without any network call (typst.ts fetched even its Latin fonts from jsdelivr), and reports characters no font covers instead of leaving them blank.

```ts
// before
import { typstRenderer } from "@junejs/pdf/typst";
pdfTools({ renderer: typstRenderer() });

// after: bun add @junejs/pdf-typst-wasm (and remove @myriaddreamin/typst.ts, typst-ts-web-compiler)
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
pdfTools({ renderer: typstWasmRenderer() });
```

Option mapping: `fonts: [bytes or url]` → `fonts: [localFonts([...])]`, and `fontFamilies` is unchanged. `fontAssets` has no equivalent: the Latin fonts are built in. For CJK, add a font with `localFonts` or `googleFontSubsets`. `fontAssets: ["cjk"]` was Simplified Chinese only.
