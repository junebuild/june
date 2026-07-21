import { defineConfig } from "tsdown";

// dist (ESM JS + .d.ts) for the default/types conditions so plain Node can consume
// @junejs/og; src/*.ts serves source/bun. Externalize every bare specifier: react
// is a peer, and the OG renderers (workers-og statically re-exported by workerd.ts,
// @vercel/og lazily imported by edge.ts) each carry resvg/yoga WASM that rolldown
// can't inline — they must resolve at the consumer, never be bundled here.
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
  deps: { neverBundle: [/^[^./]/] },
});
