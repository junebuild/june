// Deploy adapters — the seam between June's portable `fetch(Request) → Response`
// build and a deploy target. June's core artifact (createWorker(manifest)) is
// already runtime-portable (the cake demo runs the SAME bundle on Workers AND
// Vercel Edge), so an adapter does PACKAGING + BINDINGS + entry glue, never a
// re-bundle. See docs/adapter-interface-spec.md.
//
// `workers()` is the zero-config default (this file, no import). Other targets
// are explicit `deploy: { adapter: vercel() }` from their own package.
import { existsSync } from "node:fs";
import { cp, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
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

// What the app's declared resources need from the platform. Derived from
// config.resources at build time; the adapter turns it into platform bindings
// (workers() → wrangler `d1_databases` etc.). Target-neutral so a future
// vercel()/node() adapter maps the SAME plan to its own provisioning.
export type ResourcePlan = {
  // A declared `db` → a D1 binding named `binding`. The runtime provider
  // (bindWorkerResources) reads env[binding]; keep in sync (default "DB").
  db?: { binding: string; databaseName: string };
};

export type AdapterEmitContext = {
  appRoot: string;
  outDir: string;
  hasAssets: boolean;
  linkHeader: string | null;
  config: JuneConfig;
  // Platform bindings the declared resources need (empty object = none).
  plan: ResourcePlan;
  // package.json name (or sanitized dir name) — the fallback worker/app name.
  defaultName: string;
};

export interface JuneAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  // Rolldown export conditions BAKED into the bundle at build time (the target
  // runtime has none). Target-specific: workers → "workerd", vercel → "edge-light".
  // The same portable graph, resolved for the platform's module surface.
  readonly conditions: string[];
  // Reject a config this target can't honor, BEFORE the expensive build — e.g.
  // Vercel has no D1, so a declared db fails fast with a clear message instead of
  // a cryptic prerender/runtime error. Optional; default is "accept everything".
  validate?(ctx: { plan: ResourcePlan; config: JuneConfig }): void;
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
    conditions: ["workerd", "edge", "import", "default"],

    entry({ linkHeader }) {
      return {
        imports: [`import { withAssets } from "@junejs/server/worker";`],
        wrap: (pipelineVar) =>
          `export default withAssets(${pipelineVar}, { link: ${JSON.stringify(linkHeader)} });`,
      };
    },

    async emit({ appRoot, outDir, hasAssets, config, plan, defaultName }) {
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
            // A declared `db` resource → a D1 binding. database_id is per-account
            // (run `wrangler d1 create <name>` and paste it); emitted empty so
            // the binding is wired and the one missing value is obvious. With it,
            // the same `sqlite()` declaration runs on D1 at the edge.
            ...(plan.db
              ? {
                  d1_databases: [
                    {
                      binding: plan.db.binding,
                      database_name: plan.db.databaseName,
                      database_id: "",
                    },
                  ],
                }
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

// Vercel target — emits the Build Output API v3 tree (.vercel/output/). June's
// worker is already a Web-standard fetch handler, so this is packaging, not a
// re-bundle: the same portable graph (built with edge-light conditions, so
// react-dom resolves to server.edge.js) packaged for the platform.
//
// Default runtime is "node" — a Vercel Function on Fluid compute. Vercel
// deprecated the Edge Functions *product* and officially recommends the Node
// runtime for performance + reliability, and Fluid compute (in-function
// concurrency) closed the cold-start gap edge used to win on. Node also lifts
// edge's limits (no 1–4MB code cap, full API). `vercel({ runtime: "edge" })` still
// emits an Edge Function for latency-critical global cases — the runtime is not
// removed, just discouraged. BOTH run the SAME bundle; only the .func packaging
// (.vc-config.json + the export shape) differs.
//
// db: turso() works (libsql over HTTPS — the build bundles the web client, the
// request opens it from env → ambient `import { db }`). sqlite()/d1() are
// Cloudflare-only (a D1 binding); validate() rejects them with that guidance.
//
// Routing: only the hashed framework assets (/_june/*) are served statically by
// the CDN (their exact-path URLs match June's scheme); every page + projection
// (.md/.json/mcp/llms.txt) renders through the one function, so the dual-audience
// surface is identical to Workers.
const VERCEL_FUNCTION = "__june"; // → /__june, the catch-all SSR function

export function vercel(opts?: { runtime?: "node" | "edge"; regions?: string[] }): JuneAdapter {
  const isEdge = (opts?.runtime ?? "node") === "edge";
  return {
    name: "vercel",
    capabilities: {
      // Node on Fluid holds streamed/SSE connections; the edge variant keeps the
      // conservative flag it shipped with.
      runtime: isEdge ? "edge" : "node",
      persistentConnections: !isEdge,
      assets: "platform",
    },
    // The bundle is identical for both runtimes. NO "worker"/"browser": react-dom's
    // ./server exports map "worker" → the BROWSER SSR build (server.browser.js),
    // listed BEFORE "edge-light", so requesting "worker" pulls the wrong renderer.
    // "edge-light" → server.edge.js, which uses Web Streams (renderToReadableStream)
    // and runs on workerd AND Node alike. Mirrors workers()'s shape.
    conditions: ["edge-light", "edge", "import", "default"],

    validate({ config }) {
      // turso() is libsql over HTTPS — it runs on Vercel (the build bundles the web
      // client; the request opens it from env → ambient `import { db }`). sqlite()/
      // d1() need a D1 binding, which is Cloudflare-only.
      const kind = config.resources?.db?.kind;
      if (kind && kind !== "turso") {
        throw new Error(
          `vercel(): the '${kind}' db isn't supported on Vercel (D1 is Cloudflare-only).\n` +
            "  Use turso() (libsql over HTTPS) for a Vercel db, or deploy to Workers.",
        );
      }
    },

    entry() {
      // No withAssets: the CDN serves /_june/*; this function renders everything
      // else. Resources arrive via process.env (Vercel injects env vars); there
      // are no platform bindings. The Node runtime captures the `fetch` Web
      // Standard export (an object with a fetch method); the Edge runtime takes a
      // bare default function. Same pipeline call either way.
      const env = `const __env = typeof process !== "undefined" && process.env ? process.env : {};\n`;
      return {
        imports: [],
        wrap: (pipelineVar) =>
          isEdge
            ? env + `export default (request) => ${pipelineVar}.fetch(request, __env);`
            : env + `export default { fetch: (request) => ${pipelineVar}.fetch(request, __env) };`,
      };
    },

    async emit({ appRoot, outDir, hasAssets }) {
      const out = join(appRoot, ".vercel", "output");
      const fnDir = join(out, "functions", `${VERCEL_FUNCTION}.func`);
      await rm(out, { recursive: true, force: true }); // clean — no stale outputs
      await mkdir(fnDir, { recursive: true });

      // the edge function = June's portable worker bundle. Rolldown code-splits
      // (worker.js imports ./cache-*.js, ./instrumentation-*.js, …), so copy EVERY
      // top-level .js — the chunks must sit beside the entry or Vercel rejects the
      // function ("referencing unsupported modules"). assets/ is handled below.
      const jsFiles = (await readdir(outDir)).filter((f) => f.endsWith(".js"));
      for (const f of jsFiles) await copyFile(join(outDir, f), join(fnDir, f));

      const regions = opts?.regions ? { regions: opts.regions } : {};
      const vcConfig = isEdge
        ? { runtime: "edge", entrypoint: "worker.js", ...regions }
        : {
            // A Vercel Function on Fluid compute. handler = the ESM bundle entry;
            // launcherType Nodejs invokes its default `fetch` export.
            // supportsResponseStreaming is REQUIRED or a streamed Response (our SSE
            // live feed, streamed SSR) is buffered instead of flushed.
            runtime: "nodejs22.x",
            handler: "worker.js",
            launcherType: "Nodejs",
            supportsResponseStreaming: true,
            ...regions,
          };
      await writeFile(join(fnDir, ".vc-config.json"), JSON.stringify(vcConfig, null, 2) + "\n");
      // The bundle is ESM (worker.js + ./chunk-*.js all use `export`/`import`).
      // The Node runtime loads the .func as CommonJS by default, so mark the whole
      // function dir as ESM. (The edge runtime always treats sources as ESM.)
      if (!isEdge) {
        await writeFile(join(fnDir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
      }

      // static: only the hashed framework assets under /_june/ (exact-path URLs)
      if (hasAssets) {
        const src = join(outDir, "assets", "_june");
        if (existsSync(src)) await cp(src, join(out, "static", "_june"), { recursive: true });
      }

      await writeFile(
        join(out, "config.json"),
        JSON.stringify(
          {
            version: 3,
            routes: [
              {
                src: "^/_june/(.*)$",
                headers: { "cache-control": "public, max-age=31536000, immutable" },
                continue: true,
              },
              { handle: "filesystem" }, // serve any static file by exact path
              { src: "^/.*$", dest: `/${VERCEL_FUNCTION}` }, // everything else → SSR
            ],
          },
          null,
          2,
        ) + "\n",
      );
    },
  };
}

// Deno Deploy target. The SAME portable bundle as workers/vercel (edge-light →
// react-dom server.edge.js, which Deno's web-standard runtime runs); the entry
// wraps the pipeline in `Deno.serve(withDenoAssets(...))`. Deno Deploy has no CDN,
// so the handler serves /_june/* from the co-located assets/ dir itself (like
// vercel()'s split, but in-process). `june build` produces dist/{worker.js,assets}
// and `deployctl deploy` ships the dir — no Build Output tree to construct.
//
// db: turso() works (libsql over HTTPS, env-driven). sqlite()/d1() are
// Cloudflare-only; validate() rejects them.
export function deno(opts?: { org?: string; app?: string }): JuneAdapter {
  return {
    name: "deno",
    capabilities: { runtime: "edge", persistentConnections: true, assets: "server" },
    // "deno" first (a dep may ship a Deno-specific build); else edge-light →
    // server.edge.js (Web Streams + fetch, which Deno has).
    conditions: ["deno", "edge-light", "edge", "import", "default"],

    validate({ config }) {
      const kind = config.resources?.db?.kind;
      if (kind && kind !== "turso") {
        throw new Error(
          `deno(): the '${kind}' db isn't supported on Deno Deploy (D1 is Cloudflare-only).\n` +
            "  Use turso() (libsql over HTTPS) for a Deno db, or deploy to Workers.",
        );
      }
    },

    entry() {
      // The `export default { fetch }` Web Standard export — what `deno serve` (and
      // Deno Deploy's runtime) invokes, and the same shape vercel()'s Node runtime
      // uses. (A top-level `Deno.serve()` only works under `deno run`, not the
      // platform.) No env glue: withDenoAssets reads Deno.env itself.
      return {
        imports: [`import { withDenoAssets } from "@junejs/server/worker";`],
        wrap: (pipelineVar) => `export default { fetch: withDenoAssets(${pipelineVar}) };`,
      };
    },

    async emit({ outDir }) {
      // The bundle (worker.js + chunks) and assets/ already sit in outDir. The
      // deno.json declares the Deno Deploy target (org/app) + runtime entrypoint
      // (the `{ fetch }` export `deno serve` runs); source config takes precedence
      // over the dashboard, so the deploy is reproducible. `deno deploy` ships the
      // dir. org/app come from deno({ org, app }) — without them, `deno deploy`
      // prompts for the target.
      await writeFile(
        join(outDir, "deno.json"),
        JSON.stringify(
          {
            deploy: {
              ...(opts?.org ? { org: opts.org } : {}),
              ...(opts?.app ? { app: opts.app } : {}),
              runtime: { entrypoint: "worker.js" },
            },
          },
          null,
          2,
        ) + "\n",
      );
    },
  };
}
