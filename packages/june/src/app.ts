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

import { pathToFileURL } from "node:url";

import { isRouteDefinition } from "junecore/route";
import { resolveAgent, resolveSpeculationRules, type JuneConfig } from "junecore/config";
import type { DocumentConfig } from "junecore/document";
import { runWithTrace, type RequestTrace } from "junecore/instrumentation";

import { listRoutes, matchRouteTree, routeFiles, type SegmentMatch } from "./router";
import { createPipeline, type LayoutComponent, type Resolved } from "./pipeline";

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

async function loadChain(segments: SegmentMatch[]): Promise<LayoutComponent[]> {
  const chain: LayoutComponent[] = [];
  for (const seg of segments) {
    if (!seg.layout) continue;
    const L = await loadLayout(seg.layout);
    if (L) chain.push(L);
  }
  return chain;
}

export function createApp({ appDir, config = {} }: CreateAppOptions): JuneApp {
  const agent = resolveAgent(config.agent);
  const speculation = config.speculation;
  const docConfig: DocumentConfig = {
    site: config.site ?? {},
    speculationRules: resolveSpeculationRules(speculation ?? undefined),
    speculationDelivery: speculation ? speculation.delivery ?? "inline" : "inline",
    viewTransitions: config.viewTransitions ?? true,
  };

  const routePaths = () => listRoutes(appDir, { pageConvention: true });

  const pipeline = createPipeline({
    docConfig,
    agent,
    routeList: routePaths,
    earlyHints: config.earlyHints,
    resolve: async (pathname): Promise<Resolved | null> => {
      const match = await matchRouteTree(appDir, pathname, { pageConvention: true });
      if (!match) return null;
      const mod = (await import(pathToFileURL(match.file).href)) as { default?: unknown };
      if (!isRouteDefinition(mod.default)) return null;
      return { def: mod.default, params: match.params, chain: await loadChain(match.segments) };
    },
  });

  function newTrace(): RequestTrace {
    return { id: crypto.randomUUID(), startedAt: performance.now(), events: [] };
  }

  return {
    fetch(request) {
      return runWithTrace(newTrace(), () => pipeline.fetch(request));
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
