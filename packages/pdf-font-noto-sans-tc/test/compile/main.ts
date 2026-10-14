// The app scripts/smoke-compile.ts compiles with `bun build --compile`: the engine and the
// fonts must both be embedded by their imports alone. Prints the embedded font names, or the
// error.
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

try {
  const pdf = await typstWasmRenderer({ fonts: [notoSansTC()] }).render({ markdown: "# 單一執行檔\n\n**繁體中文**，離線渲染。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
