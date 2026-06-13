// Deploy adapters — the seam between June's portable `fetch(Request) → Response`
// build and a deploy target. June's core artifact (createWorker(manifest)) is
// already runtime-portable (the cake demo runs the SAME bundle on Workers AND
// Vercel Edge), so an adapter does PACKAGING + BINDINGS + entry glue, never a
// re-bundle. See docs/adapter-interface-spec.md.
//
// `workers()` is the zero-config default (this file, no import). Other targets
// are explicit `deploy: { adapter: vercel() }` from their own package.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { JuneConfig } from "@junejs/core/config";

export type AdapterCapabilities = {
  runtime: "edge" | "node" | "serverless" | "native" | "static";
  // SSE/WebSocket → live-RSC push & server-push HMR. The framework degrades
  // features that need it (with a build notice) when false. (Not yet consumed —
  // the foundation for it.)
  persistentConnections: boolean;
  // Who serves prerendered static files: the platform CDN, the server, or none.
  assets: "platform" | "server" | "none";
};

// What the adapter contributes to the generated worker entry: extra imports and
// the `export default` that wraps the portable pipeline.
export type AdapterEntry = {
  imports: string[];
  wrap(pipelineVar: string): string;
};

export type AdapterEmitContext = {
  appRoot: string;
  outDir: string;
  hasAssets: boolean;
  linkHeader: string | null;
  config: JuneConfig;
  // package.json name (or sanitized dir name) — the fallback worker/app name.
  defaultName: string;
};

export interface JuneAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  // Wrap the portable pipeline into the platform's entry source.
  entry(opts: { linkHeader: string | null }): AdapterEntry;
  // Write the deploy structure (config files, asset placement, server entry).
  emit(ctx: AdapterEmitContext): Promise<void>;
}

// The built-in default. Reproduces exactly what build.ts emitted inline:
// withAssets(pipeline) as the entry, and a wrangler.jsonc with the assets
// binding (run_worker_first) + optional custom domain.
export function workers(opts?: { name?: string; domain?: string }): JuneAdapter {
  return {
    name: "workers",
    capabilities: { runtime: "edge", persistentConnections: true, assets: "platform" },

    entry({ linkHeader }) {
      return {
        imports: [`import { withAssets } from "@junejs/server/worker";`],
        wrap: (pipelineVar) =>
          `export default withAssets(${pipelineVar}, { link: ${JSON.stringify(linkHeader)} });`,
      };
    },

    async emit({ appRoot, outDir, hasAssets, config, defaultName }) {
      // An app that manages its own wrangler config wins — don't overwrite it.
      if (existsSync(join(appRoot, "wrangler.toml")) || existsSync(join(appRoot, "wrangler.jsonc"))) {
        return;
      }
      const deployCfg = config.deploy;
      await writeFile(
        join(outDir, "wrangler.jsonc"),
        JSON.stringify(
          {
            name: opts?.name ?? deployCfg?.name ?? defaultName,
            main: "./worker.js",
            compatibility_date: "2025-01-01",
            compatibility_flags: ["nodejs_compat"],
            // run_worker_first: the worker wraps asset serving (withAssets) so
            // prerendered pages still get Link headers + Accept:markdown
            // negotiation. The ASSETS binding lets the worker serve assets.
            ...(hasAssets
              ? { assets: { directory: "./assets", binding: "ASSETS", run_worker_first: true } }
              : {}),
            // config deploy.domain → a Workers custom domain; without it the
            // regenerated file would silently drop a hand-attached domain.
            ...(opts?.domain ?? deployCfg?.domain
              ? { routes: [{ pattern: opts?.domain ?? deployCfg?.domain, custom_domain: true }] }
              : {}),
          },
          null,
          2,
        ) + "\n",
      );
    },
  };
}
