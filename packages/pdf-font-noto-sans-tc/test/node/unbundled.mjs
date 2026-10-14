// The unbundled entries on plain Node, from dist (scripts/smoke-node.ts): dist/unbundled.js
// reads the engine's ref with a JSON import, and both entries load their files through the
// app's loader, here from where the packages keep them. Prints where it resolved and the
// embedded font names, or the error.
import { readFile } from "node:fs/promises";

import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc/unbundled";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm/unbundled";

const engine = new URL("../../../pdf-typst-wasm/dist/typst.wasm", import.meta.url);
const load = (ref) => readFile(ref.name === "typst.wasm" ? engine : new URL(`../../fonts/${ref.name}`, import.meta.url));
try {
  const pdf = await typstWasmRenderer({ load, fonts: [notoSansTC({ load })] }).render({ markdown: "# 季度報告\n\n**營收**成長 12%。臺灣、裏、峯、齉龘爩鬱。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log(import.meta.resolve("@junejs/pdf-typst-wasm/unbundled"));
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
