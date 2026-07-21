import { defineConfig } from "tsdown";

// Build @junejs/server to dist (ESM JS + .d.ts) for the default/types export
// conditions so plain Node can consume it (Node won't type-strip node_modules
// .ts); src/*.ts still serves the source/bun conditions for the zero-build inner
// loop. platform: "neutral" — the host adapters span node AND edge (worker.ts,
// agent-durable.ts run on workerd), so bake in no platform assumptions.
//
// Externalize EVERY bare specifier: node: builtins, the heavy native/build deps
// (rolldown, oxc-parser, lightningcss, @momiji-rs/sparkdown), the @junejs/*
// packages (resolved at the consumer), react/react-dom/react-server-dom-webpack
// peers, and June's own `june:` virtual modules (june:app, june:rsc-*) which are
// resolved by June's bundler plugin at consumer build time — none may be bundled.
export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx"],
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
