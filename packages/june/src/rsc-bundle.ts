// RSC build pipeline — the dual React graph, bundled for STANDARD targets
// (Cloudflare Workers / Vercel edge), with NO dependency on June's native runtime.
//
// The whole trick is resolve CONDITIONS:
//   - server graph: ["react-server", "workerd", …] → `react` and
//     `react-server-dom-webpack/server` resolve to their server-graph + edge
//     (no node:*) builds. This graph renders components to a Flight stream.
//   - ssr graph:    ["workerd", …] (NO react-server) → normal `react` +
//     `react-server-dom-webpack/client` + `react-dom/server.edge`. This graph
//     consumes a Flight stream and renders it to HTML.
//
// Both bundles are worker-safe (the edge builds avoid node:*), so the worker /
// serverless function runs them directly. rolldown does the resolution — same
// engine the client bundle already uses.
import type { Plugin } from "rolldown";

import { rscClientReferencesPlugin } from "./rsc-manifest";

export type RscGraph = "server" | "ssr";

// edge-first conditions shared by both graphs; the server graph prepends
// "react-server" so React resolves to the server build.
const EDGE_CONDITIONS = ["workerd", "edge-light", "import", "default"];

async function bundleGraph(
  entryFile: string,
  cwd: string,
  graph: RscGraph,
  appAlias?: string,
  plugins: Plugin[] = [],
): Promise<string> {
  const { rolldown } = await import("rolldown");
  const conditionNames = graph === "server" ? ["react-server", ...EDGE_CONDITIONS] : EDGE_CONDITIONS;
  const bundle = await rolldown({
    input: entryFile,
    cwd,
    platform: "neutral",
    plugins,
    transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
    resolve: {
      conditionNames,
      // The generic runtime entry imports the app as "june:app"; the build aliases
      // it to the real app module so one entry serves any app.
      ...(appAlias ? { alias: { "june:app": appAlias } } : {}),
    },
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = output.find((o) => o.type === "chunk" && o.isEntry);
  return entry && entry.type === "chunk" ? entry.code : "";
}

// Bundle the server (react-server) graph that renders an app to Flight. When
// `appDir` is given, the client-references plugin rewrites that app's "use client"
// modules into client references automatically (no hand-written registration).
export function bundleServerGraph(
  entryFile: string,
  cwd: string,
  appAlias?: string,
  appDir?: string,
): Promise<string> {
  const plugins = appDir ? [rscClientReferencesPlugin(appDir)] : [];
  return bundleGraph(entryFile, cwd, "server", appAlias, plugins);
}

// Bundle the SSR (normal-react) graph that turns a Flight stream into HTML.
export function bundleSsrGraph(entryFile: string, cwd: string, appAlias?: string): Promise<string> {
  return bundleGraph(entryFile, cwd, "ssr", appAlias);
}

// True iff bundled code references node:* — the worker-safety invariant. The RSC
// edge builds must never pull node:* (Cloudflare/Vercel edge would reject it).
export function referencesNodeBuiltins(code: string): boolean {
  return /from\s*["']node:|require\(\s*["']node:/.test(code);
}
