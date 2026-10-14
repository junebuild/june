---
"@junejs/pdf-typst-wasm": minor
---

Fonts are now providers, and the default renders offline (#371). Before, every document with non-ASCII text sent those characters to fonts.googleapis.com unless you knew to turn it off. Now the renderer makes no network call unless you add a provider that does, and each provider declares what it sends where.

```ts
import { googleFontSubsets, localFonts, typstWasmRenderer } from "@junejs/pdf-typst-wasm";

typstWasmRenderer();                                            // offline: Typst's built-in fonts
typstWasmRenderer({ fonts: [localFonts([notoSansTcBytes])] });  // offline, with your CJK font
typstWasmRenderer({ fonts: [googleFontSubsets({ families: [{ family: "Noto Sans TC", weights: [400, 700] }] })] });
```

- `renderer.egress` lists each host the configured fonts contact and whether it receives the document's characters. It is `[]` when the renderer works offline. Show it in a setup check or your docs.
- A character no font covers fails the render with a `PdfRenderError` (see the previous change), so going offline can't silently produce blank text.
- Write your own provider: `{ name, egress, persistent?(), forDocument?(text) }`.

**Migrating:**

- **You relied on the default for Chinese.** Add `fonts: [googleFontSubsets({ families: [{ family: "Noto Sans TC", weights: [400, 700] }] })]` to keep the old behavior. Otherwise a CJK document now fails with an error naming the missing characters.
- `googleFonts: [...]` → `fonts: [googleFontSubsets({ families: [...] })]`.
- `googleFonts: false` → remove it; offline is the default.
- `fonts: [bytes, url, loader]` → `fonts: [localFonts([bytes, url, loader])]`.
- `fetch` moved from the renderer to the provider that fetches: `googleFontSubsets({ families, fetch })`, `localFonts(sources, { fetch })`.
- `DEFAULT_GOOGLE_FONTS` is removed.
