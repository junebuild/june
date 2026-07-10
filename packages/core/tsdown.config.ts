import { defineConfig } from "tsdown";

// Build @junejs/core to dist (ESM JS + .d.ts) for the `default`/`types` export
// conditions — so plain Node can consume it (Node refuses to type-strip
// node_modules .ts). The `source`/`bun` conditions still serve src/*.ts for the
// zero-build inner loop. One entry per src file so each subpath export maps to a
// dist file; a bundler resolves the extensionless relative imports that plain
// tsc emit can't.
export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx"],
  format: "esm",
  dts: true,
  outDir: "dist",
  platform: "neutral", // runs on node AND edge — no node:* baked in
  // JSX in the .tsx files routes through June's own automatic runtime — driven by
  // tsconfig's jsx: "react-jsx" + jsxImportSource: "@junejs/core" (oxc reads it).
  // react / react-dom are peers — never bundle them into dist.
  deps: { neverBundle: [/^react($|\/)/, /^react-dom($|\/)/] },
});
