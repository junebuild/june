// The app scripts/smoke-node.ts runs on plain Node: no --conditions=source, no tsx, so both
// packages resolve the `default` condition to their dist, as an npm user gets them. Prints
// where they resolved and the embedded font names, or the error.
import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer({ fonts: [notoSansJP()] }).render({ markdown: "# 四半期報告\n\n**売上**は12%増加しました。ひらがな、カタカナ、漢字。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log(import.meta.resolve("@junejs/pdf-font-noto-sans-jp"));
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
