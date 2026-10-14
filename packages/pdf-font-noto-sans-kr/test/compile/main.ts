// The app scripts/smoke-compile.ts compiles with `bun build --compile`: the engine and the
// fonts must both be embedded by their imports alone. Prints the embedded font names, or the
// error.
import { notoSansKR } from "@junejs/pdf-font-noto-sans-kr";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer({ fonts: [notoSansKR()] }).render({ markdown: "# 분기 보고서\n\n**매출**이 12% 증가했습니다. 한글과 漢字." });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
