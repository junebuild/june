import { defineConfig } from "tsdown";

// Build @junejs/cli's `.` export (src/cli.ts, the testable run(argv) surface) to
// dist so plain Node importers work — Node won't type-strip node_modules .ts.
// Only the exported entry is built; the `june` bin still spawns src/june.ts raw
// under Bun (bin.mjs hardcodes that path), so src stays shipped alongside dist.
// Everything bare is external: node: builtins + the @junejs/* deps.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  dts: true,
  outDir: "dist",
  platform: "neutral",
  deps: { neverBundle: [/^[^./]/] },
});
