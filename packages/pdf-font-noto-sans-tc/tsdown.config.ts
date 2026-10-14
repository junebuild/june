import { defineConfig } from "tsdown";

// dist (ESM JS + .d.ts) for the default/workerd conditions; src/*.ts serves source/bun. The
// font files stay files next to the JS: workerd.js imports ../fonts/*.otf (wrangler uploads
// them as Data modules), node.js reads them from disk. Never bundled, never inlined.
export default defineConfig({
  entry: ["src/node.ts", "src/workerd.ts"],
  format: "esm",
  dts: true,
  attw: { profile: "esm-only", level: "error" },
  publint: true,
  outDir: "dist",
  platform: "neutral",
  deps: { neverBundle: [/^[^./]/, /\.otf$/] },
});
