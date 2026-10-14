---
"@junejs/pdf-typst-wasm": minor
---

Characters no loaded font covers are now an error instead of blanks in the PDF (#368). Before, a CJK document with `googleFonts: false`, or one whose Google Fonts fetch failed, came out with those characters silently missing; an emoji did the same.

- `render` throws a `PdfRenderError` naming the characters (the first ten, then a count) and any font that failed to fetch. `render_pdf` hands it to the model, which can drop a decorative emoji or tell the user.
- To keep the old behavior, pass `onMissingGlyphs: "warn"`: the PDF renders with those characters blank and the message is logged.
- A font that fails to fetch no longer logs a warning by itself. It shows up in the error only when its characters end up uncovered.
- **Breaking, for code that drives the engine directly:** `TypstEngine.compile` returns `{ pdf, missingGlyphs }` instead of the PDF bytes. Migrate with `engine.compile(source).pdf`.
