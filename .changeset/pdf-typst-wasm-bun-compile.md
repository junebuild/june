---
"@junejs/pdf-typst-wasm": patch
---

`bun build --compile` now embeds the engine, so a single-file binary renders PDFs with no configuration (#367). Before, the binary was built without `typst.wasm`, and the first `render_pdf` failed with a message telling you to build the June repo. On Bun the package now imports the module `with { type: "file" }`, which the bundler sees. It is still loaded only on the first render.

If you worked around this by passing `wasm` yourself, you can remove that option. On Node, the missing-module error now also points single-file builds to the `wasm` option.
