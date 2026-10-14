// The unbundled app scripts/smoke-compile.ts compiles: it embeds no engine, and loads it from
// the path in JUNE_TYPST_WASM on the first render, as an app reading a cache would. Prints the
// PDF's header and size, or the error.
import { readFile } from "node:fs/promises";

import { typstWasmRenderer } from "@junejs/pdf-typst-wasm/unbundled";

try {
  const renderer = typstWasmRenderer({ load: () => readFile(process.env.JUNE_TYPST_WASM!) });
  const pdf = await renderer.render({ markdown: "# Unbundled\n\nThe engine came from outside the binary." });
  console.log(`${new TextDecoder("latin1").decode(pdf.slice(0, 5))} ${pdf.length}`);
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
