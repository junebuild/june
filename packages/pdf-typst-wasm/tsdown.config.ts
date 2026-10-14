import { defineConfig } from "tsdown";

// dist (ESM JS + .d.ts) for the default/workerd conditions; src/*.ts serves source/bun. The
// engine module stays a file next to the JS: workerd.js imports ../dist/typst.wasm (wrangler
// uploads it as a compiled module), node.js reads it from disk. Never bundled, never inlined.
export default defineConfig({
  entry: ["src/node.ts", "src/workerd.ts", "src/unbundled.ts"],
  format: "esm",
  dts: true,
  // ./typst.wasm is a binary export (for bundlers that import the module themselves), not a
  // JS entry point attw can resolve types for.
  attw: { profile: "esm-only", level: "error", excludeEntrypoints: ["./typst.wasm"] },
  publint: true,
  outDir: "dist",
  clean: false, // dist/typst.wasm is built first (build:wasm)
  platform: "neutral",
  deps: { neverBundle: [/^[^./]/, /\.wasm$/, /\.ref\.json$/] },
});
