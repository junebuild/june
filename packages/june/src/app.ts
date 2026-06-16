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

import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";

import { routeFromModule } from "@junejs/core/route";
import { resolveAgent, resolveSpeculationRules, type JuneConfig } from "@junejs/core/config";
import type { DocumentConfig } from "@junejs/core/document";
import { runWithTrace, type RequestTrace } from "@junejs/core/instrumentation";

import { findMiddlewareFile, isResourceFile, listRoutes, matchRouteTree, resolveNotFound, routeFiles, type SegmentMatch } from "./router";
import { createPipeline, type ExtraHandler, type LayoutComponent, type Pipeline, type Resolved, type ResourceHandler } from "./pipeline";
import { memoizeResources } from "./resources";
import { findClientEntry, bundleClientToString, CLIENT_SCRIPT_URL } from "./client-bundle";
import { findGlobalCss, processCssCached, STYLES_URL } from "./css";
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

// Import a layout file's default export as a layout component (memoized).
const layoutCache = new Map<string, LayoutComponent>();
async function loadLayout(file: string): Promise<LayoutComponent | null> {
  const cached = layoutCache.get(file);
  if (cached) return cached;
  const mod = (await import(pathToFileURL(file).href)) as { default?: LayoutComponent };
  if (typeof mod.default !== "function") return null;
  layoutCache.set(file, mod.default);
  return mod.default;
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

async function loadChain(segments: SegmentMatch[]): Promise<LayoutComponent[]> {
  const chain: LayoutComponent[] = [];
  for (const seg of segments) {
    if (!seg.layout) continue;
    const L = await loadLayout(seg.layout);
    if (L) chain.push(L);
  }
  return chain;
}

export function createApp({ appDir: appDirInput, config = {} }: CreateAppOptions): JuneApp {
  // Normalize once: rolldown resolves the client entry against an absolute cwd,
  // so a relative appDir would double the path. Absolute from here on.
  const appDir = resolve(appDirInput);
  const agent = resolveAgent(config.agent);
  const speculation = config.speculation;
  // app/_client.* present → the dev document loads /client.js and we serve it
  // (bundled lazily, memoized). Detected the same way the build freezes it, so
  // dev and built surfaces agree.
  const clientEntry = findClientEntry(appDir);
  const cssEntry = findGlobalCss(appDir);
  const docConfig: DocumentConfig = {
    site: config.site ?? {},
    speculationRules: resolveSpeculationRules(speculation ?? undefined),
    speculationDelivery: speculation ? speculation.delivery ?? "inline" : "inline",
    viewTransitions: config.viewTransitions ?? true,
    clientRouter: config.clientRouter ?? false,
    clientScript: clientEntry ? CLIENT_SCRIPT_URL : null,
    styles: cssEntry ? STYLES_URL : null,
  };

  // CSS Modules: glob + transform app/**/*.module.css ONCE (memoized) → the maps
  // (runtime interceptor + client bundle look these up) + the collected sheet.
  let moduleCssPromise: Promise<{ maps: ModuleMaps; css: string | null }> | undefined;
  const getModuleCss = () => (moduleCssPromise ??= buildModuleCss(appDir, dirname(appDir)));

  let clientBundle: Promise<string> | undefined;
  const serveClient = (): Promise<string> =>
    // cwd = the app ROOT (appDir's parent) so rolldown resolves node_modules
    // from the project, exactly like the build does. Islands may import .module.css.
    (clientBundle ??= getModuleCss().then(({ maps }) =>
      bundleClientToString(clientEntry!, dirname(appDir), maps),
    ));

  const routePaths = () => listRoutes(appDir, { pageConvention: true });

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
      routeList: routePaths,
      earlyHints: config.earlyHints,
      resources,
      notFoundComponent,
      resolve: async (pathname) => {
        const match = await matchRouteTree(appDir, pathname, { pageConvention: true });
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
        return {
          def,
          params: match.params,
          chain: await loadChain(match.segments),
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
      // Dev serves the islands runtime itself (build ships it as a static
      // asset); bundled on first hit, memoized after.
      if (clientEntry && new URL(request.url).pathname === CLIENT_SCRIPT_URL) {
        return serveClient().then(
          (code) =>
            new Response(code, {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            }),
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
      return runWithTrace(newTrace(), async () => (await getPipeline()).fetch(request));
    },
    async warmup() {
      for (const file of await routeFiles(appDir, { pageConvention: true })) {
        await import(pathToFileURL(file).href).catch((err) => {
          console.error(`[june] failed to load route ${file}`, err);
        });
      }
    },
    routePaths,
    earlyHints: () => config.earlyHints ?? [],
  };
}
