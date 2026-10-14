// The app scripts/smoke-node.ts runs on plain Node: no --conditions=source, no tsx, so both
// packages resolve the `default` condition to their dist, as an npm user gets them. Prints
// where they resolved and the embedded font names, or the error.
import { notoSansKR } from "@junejs/pdf-font-noto-sans-kr";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer({ fonts: [notoSansKR()] }).render({ markdown: "# 분기 보고서\n\n**매출**이 12% 증가했습니다. 한글과 漢字." });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log(import.meta.resolve("@junejs/pdf-font-noto-sans-kr"));
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
