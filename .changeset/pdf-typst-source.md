---
"@junejs/pdf": minor
---

`markdownToTypst` and `typstSource` are exported from `@junejs/pdf`. They are the Markdown → Typst conversion `typstRenderer` uses, so a renderer built on any Typst compiler (your own, or `@junejs/pdf-typst-wasm`) gets the same document from the same Markdown.
