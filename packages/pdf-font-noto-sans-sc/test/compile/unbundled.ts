// The unbundled app scripts/smoke-compile.ts compiles: neither the engine nor the fonts are
// embedded. Both load on the first render from the directory in JUNE_ASSETS, by file name, as
// an app with a cache on a volume would (#383). Prints the embedded font names, or the error.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { notoSansSC } from "@junejs/pdf-font-noto-sans-sc/unbundled";
import { typstWasmRenderer, type AssetRef } from "@junejs/pdf-typst-wasm/unbundled";

const load = (ref: AssetRef) => readFile(join(process.env.JUNE_ASSETS!, ref.name));
try {
  const pdf = await typstWasmRenderer({ load, fonts: [notoSansSC({ load })] }).render({ markdown: "# 季度报告\n\n**营收**增长 12%。简体中文：龘、齉、爩。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
