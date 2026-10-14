// The cached app scripts/smoke-compile.ts compiles: the unbundled entries with
// @junejs/server's assetCache over the directory in JUNE_ASSETS (#383). With JUNE_MIRROR set,
// files missing from the directory are fetched from that origin; without it the cache is
// offline and serves only what the directory holds. Prints the embedded font names, or the
// error.
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc/unbundled";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm/unbundled";
import { assetCache } from "@junejs/server/assets";

const mirror = process.env.JUNE_MIRROR;
const load = assetCache({ dir: process.env.JUNE_ASSETS!, offline: !mirror, urls: (ref) => [`${mirror}/${ref.name}`] });
try {
  const pdf = await typstWasmRenderer({ load, fonts: [notoSansTC({ load })] }).render({ markdown: "# 季度報告\n\n**營收**成長 12%。臺灣、裏、峯、齉龘爩鬱。" });
  const s = new TextDecoder("latin1").decode(pdf);
  console.log([...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))].join(" "));
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
