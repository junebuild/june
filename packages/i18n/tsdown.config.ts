import { defineConfig } from "tsdown";

// Build to dist (ESM JS + .d.ts) for the default/types export conditions so plain
// Node can consume this package (Node won't type-strip node_modules .ts); src/*.ts
// still serves the source/bun conditions. Deps/peerDeps are auto-externalized.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  dts: true,
  outDir: "dist",
  platform: "neutral",
});
