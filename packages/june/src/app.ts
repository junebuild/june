// The dev server app: filesystem-driven discovery wired to the shared render
// core (pipeline.ts). createApp() returns a Web-standard fetch(); the ONLY
// dev-specific logic is the RouteResolver (walk app/, import the module, load
// the layout chain) and the per-request trace wrapper. Everything else —
// projections, discovery, document, layout wrapping — is the same code the
// built worker runs, so dev and prod surfaces match by construction.
//
// CONFIG IS LOAD-BEARING: site name, agent flags, view transitions, speculation
// all change observable output (test/config-output.test.ts) — the PoC shipped a
// dev server that silently ignored june.config.ts for days.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { routeFromModule } from "@junejs/core/route";
import {
  resolveAgent,
  resolveClientRouter,
  resolveSpeculationRules,
  type JuneConfig,
} from "@junejs/core/config";
import type { DocumentConfig } from "@junejs/core/document";
import { runWithTrace, type RequestTrace } from "@junejs/core/instrumentation";

import { findMiddlewareFile, isResourceFile, listRoutes, matchRouteTree, resolveNotFound, routeFiles, type SegmentMatch } from "./router";
import { createPipeline, type ExtraHandler, type LayoutComponent, type Pipeline, type Resolved, type ResourceHandler } from "./pipeline";
import { resolveBoundary } from "./segment";
import { memoizeResources } from "./resources";
import {
  findClientEntry,
  bundleClientSplit,
  CLIENT_SCRIPT_URL,
  type ClientChunks,
} from "./client-bundle";
import { generateIslandRegistry } from "./island-registry";
import { findGlobalCss, globalCssUsesTailwind, processCssCached, STYLES_URL } from "./css";
import { buildModuleCss, registerCssModules, MODULE_STYLES_URL, type ModuleMaps } from "./css-modules";

export type CreateAppOptions = {
  appDir: string;
  config?: JuneConfig;
};

export type JuneApp = {
  fetch(request: Request): Promise<Response>;
  // Import every route module once so defineAction() side effects register
  // before the agent surface (discovery / mcp) is queried.
  warmup(): Promise<void>;
  routePaths(): Promise<string[]>;
  earlyHints(): string[];
};

// Import a layout file's default export as a layout component (memoized), plus
// its static `segmentBoundary` flag — read from the module export WITHOUT
// rendering the component, which is what lets the server slice the chain for a
// segment-scoped fragment without paying the shell's render cost.
type LoadedLayout = { component: LayoutComponent; boundary: boolean };
const layoutCache = new Map<string, LoadedLayout | null>();
async function loadLayout(file: string): Promise<LoadedLayout | null> {
  const cached = layoutCache.get(file);
  if (cached !== undefined) return cached;
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: LayoutComponent;
    segmentBoundary?: unknown;
  };
  const result: LoadedLayout | null =
    typeof mod.default === "function"
      ? { component: mod.default, boundary: mod.segmentBoundary === true }
      : null;
  layoutCache.set(file, result);
  return result;
}

// The nearest loading.tsx up the segment chain (deepest wins) → the streaming
// Suspense fallback. Memoized like layouts.
const loadingCache = new Map<string, React.ComponentType>();
async function nearestLoading(segments: SegmentMatch[]): Promise<React.ComponentType | undefined> {
  const file = [...segments].reverse().find((s) => s.loading)?.loading;
  if (!file) return undefined;
  const cached = loadingCache.get(file);
  if (cached) return cached;
  const mod = (await import(pathToFileURL(file).href)) as { default?: React.ComponentType };
  if (typeof mod.default !== "function") return undefined;
  loadingCache.set(file, mod.default);
  return mod.default;
}

// The layout chain (root→leaf) plus the segment boundary, via the shared
// resolver (the one place the deepest-wins rule + shell key live, so dev and the
// frozen manifest can't drift).
async function loadChain(
  segments: SegmentMatch[],
): Promise<{ chain: LayoutComponent[]; boundaryIndex: number | null; boundaryKey: string | null }> {
  const items = [];
  for (const seg of segments) {
    if (!seg.layout) continue;
    const L = await loadLayout(seg.layout);
    items.push({ file: seg.layout, entry: L?.component ?? null, boundary: !!L?.boundary });
  }
  const { chain, boundaryIndex, key } = resolveBoundary(items);
  return { chain, boundaryIndex, boundaryKey: key };
}

export function createApp({ appDir: appDirInput, config = {} }: CreateAppOptions): JuneApp {
  // Normalize once: rolldown resolves the client entry against an absolute cwd,
  // so a relative appDir would double the path. Absolute from here on.
  const appDir = resolve(appDirInput);
  // Generated routes (e.g. kura's docs/home/search) live in .june/routes/; buildManifest merges
  // them into the route set (app/ wins). The DEV resolver must do the same — otherwise every
  // generated page 404s under `kura dev` while `kura build` serves it (a dev/build asymmetry).
  // app/ stays the priority/escape-hatch; this is the framework slot, consulted as a fallback.
  const juneRoutesDir = join(dirname(appDir), ".june", "routes");
  const hasJuneRoutes = existsSync(juneRoutesDir);
  const agent = resolveAgent(config.agent);
  const speculation = config.speculation;
  // app/_client.* present → the dev document loads /client.js and we serve it
  // (bundled lazily, memoized). Detected the same way the build freezes it, so
  // dev and built surfaces agree.
  const clientEntry =
    findClientEntry(appDir) ??
    findClientEntry(join(dirname(appDir), ".june", "routes"));
  const cssEntry = findGlobalCss(appDir);
  const docConfig: DocumentConfig = {
    site: config.site ?? {},
    speculationRules: resolveSpeculationRules(speculation ?? undefined),
    speculationDelivery: speculation ? speculation.delivery ?? "inline" : "inline",
    viewTransitions: config.viewTransitions ?? true,
    // Default the baseline reset OFF when the app uses Tailwind (its Preflight is the reset).
    cssReset: config.cssReset ?? !globalCssUsesTailwind(appDir),
    clientRouter: resolveClientRouter(config.clientRouter),
    clientScript: clientEntry ? CLIENT_SCRIPT_URL : null,
    styles: cssEntry ? STYLES_URL : null,
  };

  // CSS Modules: glob + transform app/**/*.module.css ONCE (memoized) → the maps
  // (runtime interceptor + client bundle look these up) + the collected sheet.
  let moduleCssPromise: Promise<{ maps: ModuleMaps; css: string | null }> | undefined;
  const getModuleCss = () => (moduleCssPromise ??= buildModuleCss(appDir, dirname(appDir)));

  // Split build: one chunk per island + a shared React chunk, all keyed by file
  // name. The entry is "client.js"; island chunks load on demand. cwd = the app
  // ROOT so rolldown resolves node_modules from the project, like the build does.
  let clientBundle: Promise<ClientChunks> | undefined;
  const serveClient = (): Promise<ClientChunks> =>
    (clientBundle ??= getModuleCss().then(({ maps }) => {
      // Regenerate app/_islands.gen.ts (the auto lazy registry) right before
      // bundling, so a freshly added island() module is wired without a restart.
      generateIslandRegistry(appDir);
      return bundleClientSplit(clientEntry!, dirname(appDir), "development", maps);
    }));

  // app/ routes + generated .june/routes/ (app/ wins on path collision), for sitemap / llms.txt.
  const routePaths = async () => {
    const own = await listRoutes(appDir, { pageConvention: true });
    if (!hasJuneRoutes) return own;
    const seen = new Set(own);
    const gen = (await listRoutes(juneRoutesDir, { pageConvention: true })).filter((p) => !seen.has(p));
    return [...own, ...gen].sort();
  };

  const resources = memoizeResources(config.resources);

  // Boot the opt-in Tier-3 data layer (e.g. `dataLayer: junoDataLayer()`) once:
  // its install() wires the ambient `db` (Juno registers its SQL tagger). Explicit
  // and config-declared — no import-time side-effect, and the framework still never
  // imports the data layer (the user's config does).
  config.dataLayer?.install();

  // The app's not-found.tsx is part of the dev surface too (the build freezes
  // it into the manifest as `notFound`), and importing it is async — so the
  // pipeline is built lazily on first fetch, memoized after.
  let pipelinePromise: Promise<Pipeline> | undefined;
  const getPipeline = (): Promise<Pipeline> => (pipelinePromise ??= buildPipeline());
  async function buildPipeline(): Promise<Pipeline> {
    // Wire CSS Modules BEFORE any route import: the runtime interceptor must be
    // active so `import "x.module.css"` in a route resolves to the scoped map,
    // and the document must link the collected sheet.
    const { maps, css } = await getModuleCss();
    await registerCssModules(maps);
    if (css !== null) docConfig.moduleStyles = MODULE_STYLES_URL;

    const { notFound } = await resolveNotFound(appDir, "/");
    let notFoundComponent: ComponentType<{ pathname: string }> | undefined;
    if (notFound) {
      const mod = (await import(pathToFileURL(notFound).href)) as { default?: unknown };
      if (typeof mod.default === "function") {
        notFoundComponent = mod.default as ComponentType<{ pathname: string }>;
      }
    }
    let extra: ExtraHandler | undefined;
    const extraFile = findMiddlewareFile(appDir);
    if (extraFile) {
      const mod = (await import(pathToFileURL(extraFile).href)) as { default?: unknown };
      if (typeof mod.default === "function") extra = mod.default as ExtraHandler;
    }
    return createPipeline({
      extra,
      docConfig,
      agent,
      i18n: config.i18n,
      routeList: routePaths,
      earlyHints: config.earlyHints,
      resources,
      notFoundComponent,
      resolve: async (pathname) => {
        const match =
          (await matchRouteTree(appDir, pathname, { pageConvention: true })) ??
          (hasJuneRoutes ? await matchRouteTree(juneRoutesDir, pathname, { pageConvention: true }) : null);
        if (!match) return null;
        const mod = await import(pathToFileURL(match.file).href);
        // Resource route (route.*): the default export is the Response handler.
        if (isResourceFile(match.file)) {
          const handler = (mod as { default?: unknown }).default;
          if (typeof handler !== "function") return null;
          return { handler: handler as ResourceHandler, params: match.params };
        }
        const def = routeFromModule(mod);
        if (!def) return null;
        const { chain, boundaryIndex, boundaryKey } = await loadChain(match.segments);
        return {
          def,
          params: match.params,
          chain,
          boundaryIndex,
          boundaryKey,
          loading: await nearestLoading(match.segments),
        } satisfies Resolved;
      },
    });
  }

  function newTrace(): RequestTrace {
    return { id: crypto.randomUUID(), startedAt: performance.now(), events: [] };
  }

  return {
    fetch(request) {
      // Dev serves the global stylesheet (build ships it as a static asset);
      // re-read+processed each hit so edits show on reload, like /client.js.
      if (cssEntry && new URL(request.url).pathname === STYLES_URL) {
        return processCssCached(appDir).then(
          (css) =>
            new Response(css ?? "", {
              headers: { "content-type": "text/css; charset=utf-8" },
            }),
          (err: unknown) => {
            console.error("[june] global.css failed:", err);
            return new Response(`/* global.css failed: ${err instanceof Error ? err.message : String(err)} */\n`, {
              status: 500,
              headers: { "content-type": "text/css; charset=utf-8" },
            });
          },
        );
      }
      // Dev serves the collected CSS-Modules stylesheet (build ships it hashed).
      if (new URL(request.url).pathname === MODULE_STYLES_URL) {
        return getModuleCss().then(
          ({ css }) =>
            new Response(css ?? "", { headers: { "content-type": "text/css; charset=utf-8" } }),
        );
      }
      // Dev serves the islands runtime itself (build ships it as static assets);
      // bundled on first hit, memoized after. Split build → many chunks under
      // /_june/: the entry is /_june/client.js, islands are /_june/<name>.js,
      // loaded on demand by the lazy runtime.
      {
        const pathname = new URL(request.url).pathname;
        if (clientEntry && pathname.startsWith("/_june/") && pathname.endsWith(".js")) {
          const file = pathname.slice("/_june/".length);
          return serveClient().then(
            (chunks) => {
              const code = chunks.get(file);
              if (code === undefined)
                return new Response(`unknown client chunk: ${file}\n`, {
                  status: 404,
                  headers: { "content-type": "text/plain; charset=utf-8" },
                });
              return new Response(code, {
                headers: { "content-type": "text/javascript; charset=utf-8" },
              });
            },
            (err: unknown) => {
            // A rejected bundle must answer, not hang the request (Bun.serve
            // times the handler out) — and must not be memoized, or the error
            // outlives its cause.
            clientBundle = undefined;
            console.error("[june] client bundle failed:", err);
            return new Response(`client bundle failed: ${err instanceof Error ? err.message : String(err)}\n`, {
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
            },
          );
        }
      }
      return runWithTrace(newTrace(), async () => (await getPipeline()).fetch(request));
    },
    async warmup() {
      const files = await routeFiles(appDir, { pageConvention: true });
      if (hasJuneRoutes) files.push(...(await routeFiles(juneRoutesDir, { pageConvention: true })));
      for (const file of files) {
        await import(pathToFileURL(file).href).catch((err) => {
          console.error(`[june] failed to load route ${file}`, err);
        });
      }
    },
    routePaths,
    earlyHints: () => config.earlyHints ?? [],
  };
}
