// The app scripts/smoke-compile.ts compiles with `bun build --compile`: the package as an app
// imports it, with no `wasm` option, so the engine module must be embedded by the import
// alone (#367). Prints the PDF's header and size, or the error.
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer().render({ markdown: "# Compiled\n\nRendered inside a single-file binary." });
  console.log(`${new TextDecoder("latin1").decode(pdf.slice(0, 5))} ${pdf.length}`);
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
