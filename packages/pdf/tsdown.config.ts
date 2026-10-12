import { defineConfig } from "tsdown";

// dist (ESM JS + .d.ts) for the default/types conditions so plain Node can consume
// @junejs/pdf; src/*.ts serves source/bun. Externalize every bare specifier: the Typst
// compiler and its 28 MB WASM must resolve at the consumer, never be bundled here.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  dts: true,
  attw: { profile: "esm-only", level: "error" },
  publint: true,
  outDir: "dist",
  platform: "neutral",
  deps: { neverBundle: [/^[^./]/] },
});
