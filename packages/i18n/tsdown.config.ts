import { defineConfig } from "tsdown";

// Build to dist (ESM JS + .d.ts) for the default/types export conditions so plain
// Node can consume this package (Node won't type-strip node_modules .ts); src/*.ts
// still serves the source/bun conditions. Deps/peerDeps are auto-externalized.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  dts: true,
  // Gate the published type surface: attw resolves the packed package the way
  // consumers' tsc does (ESM-only — CJS resolution failures don't apply);
  // publint lints the exports map. Both fail the build on real problems.
  attw: { profile: "esm-only", level: "error" },
  publint: true,
  outDir: "dist",
  platform: "neutral",
});
