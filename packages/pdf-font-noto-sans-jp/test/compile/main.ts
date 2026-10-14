// The app scripts/smoke-compile.ts compiles with `bun build --compile`: the engine and the
// fonts must both be embedded by their imports alone. Prints the embedded font names, or the
// error.
import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer({ fonts: [notoSansJP()] }).render({ markdown: "# 四半期報告\n\n**売上**は12%増加しました。ひらがな、カタカナ、漢字。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
