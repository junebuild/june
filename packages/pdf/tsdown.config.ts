import { defineConfig } from "tsdown";

// dist (ESM JS + .d.ts) for the default/types conditions so plain Node can consume
// @junejs/pdf; src/*.ts serves source/bun. Externalize every bare specifier: dependencies
// resolve at the consumer, never bundled here.
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
