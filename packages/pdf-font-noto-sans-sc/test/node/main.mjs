// The app scripts/smoke-node.ts runs on plain Node: no --conditions=source, no tsx, so both
// packages resolve the `default` condition to their dist, as an npm user gets them. Prints
// where they resolved and the embedded font names, or the error.
import { notoSansSC } from "@junejs/pdf-font-noto-sans-sc";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer({ fonts: [notoSansSC()] }).render({ markdown: "# 季度报告\n\n**营收**增长 12%。简体中文：龘、齉、爩。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log(import.meta.resolve("@junejs/pdf-font-noto-sans-sc"));
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
