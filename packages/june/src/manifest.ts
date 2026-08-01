// The FREEZE, in-process: import route modules + layouts, build the manifest a
// createWorker() can run immediately. Extracted from build.ts; used by
// prerender and by the parity test (its render path is identical to the
// Rolldown-bundled worker).

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { routeFromModule, type BrandedRoute } from "@junejs/core/route";
import { freezeConfig } from "./config-freeze";
import type { ExtraHandler, LayoutComponent, LoadingComponent, ResourceHandler } from "./pipeline";
import { scanAppRoutes } from "./route-scan";
import { findMiddlewareFile } from "./router";
import { resolveBoundary } from "./segment";
import type { WorkerManifest } from "./worker";

export type ImportedLayout = { component: LayoutComponent; boundary: boolean };
export async function importLayout(file: string): Promise<ImportedLayout | null> {
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: LayoutComponent;
    segmentBoundary?: unknown;
  };
  return typeof mod.default === "function"
    ? { component: mod.default, boundary: mod.segmentBoundary === true }
    : null;
}

export async function buildManifest(appRoot: string): Promise<WorkerManifest> {
  const appDir = join(appRoot, "app");
  const frozen = await freezeConfig(appRoot);
  const scanned = await scanAppRoutes(appRoot);

  const layoutCache = new Map<string, ImportedLayout | null>();
  const loadCached = async (f: string): Promise<ImportedLayout | null> => {
    if (!layoutCache.has(f)) layoutCache.set(f, await importLayout(f));
    return layoutCache.get(f) ?? null;
  };
  // The chain (root→leaf) + boundary index + shell key, via the SHARED resolver
  // (the one place the deepest-wins rule lives), so the frozen manifest and the
  // dev resolver can't drift — the parity contract.
  const componentsFor = async (
    files: string[],
  ): Promise<{ chain: LayoutComponent[]; boundaryIndex: number | null; key: string | null }> => {
    const items = [];
    for (const f of files) {
      const c = await loadCached(f);
      items.push({ file: f, entry: c?.component ?? null, boundary: !!c?.boundary });
    }
    return resolveBoundary(items);
  };

  const loadingCache = new Map<string, LoadingComponent | null>();
  const loadingFor = async (file?: string): Promise<LoadingComponent | undefined> => {
    if (!file) return undefined;
    if (!loadingCache.has(file)) {
      const loaded = await importLayout(file);
      loadingCache.set(file, loaded ? (loaded.component as LoadingComponent) : null);
    }
    return loadingCache.get(file) ?? undefined;
  };

  const routes: Record<string, BrandedRoute> = {};
  const dynamicRoutes: Array<{ pattern: string; def: BrandedRoute }> = [];
  const resourceRoutes: Array<{ pattern: string; handler: ResourceHandler }> = [];
  const layoutChains: Record<string, LayoutComponent[]> = {};
  const layoutBoundaries: Record<string, { index: number; key: string }> = {};
  const loadings: Record<string, LoadingComponent> = {};

  for (const r of scanned) {
    const mod = await import(pathToFileURL(r.file).href);
    // Resource route (route.*): the default export is the Response handler.
    if (r.resource) {
      const handler = (mod as { default?: unknown }).default;
      if (typeof handler === "function") resourceRoutes.push({ pattern: r.path, handler: handler as ResourceHandler });
      continue;
    }
    const def = routeFromModule(mod);
    if (!def) continue;
    const { chain, boundaryIndex, key } = await componentsFor(r.layouts);
    const loading = await loadingFor(r.loading);
    if (r.dynamic) {
      dynamicRoutes.push({ pattern: r.path, def });
      layoutChains[r.path] = chain;
    } else {
      routes[r.path] = def;
      layoutChains[r.path] = chain;
    }
    if (boundaryIndex !== null && key !== null) layoutBoundaries[r.path] = { index: boundaryIndex, key };
    if (loading) loadings[r.path] = loading;
  }

  let extra: ExtraHandler | undefined;
  const extraFile = findMiddlewareFile(appDir);
  if (extraFile) {
    const mod = (await import(pathToFileURL(extraFile).href)) as { default?: unknown };
    if (typeof mod.default === "function") extra = mod.default as ExtraHandler;
  }

  // The durable agent's DO address (createWorker routes the chat endpoint by
  // it). Set whenever an agent/ directory exists — the surface is inert without
  // an env.AGENT binding, so in-process consumers (prerender, the parity test)
  // are unaffected.
  let agentName: string | undefined;
  const agentDir = join(appDir, frozen.agent.runtime.dir);
  if (frozen.agent.runtime.enabled && existsSync(agentDir)) {
    const cfgFile = join(agentDir, "agent.ts");
    const cfg = existsSync(cfgFile)
      ? ((await import(pathToFileURL(cfgFile).href)).default as { name?: string } | undefined)
      : undefined;
    agentName = cfg?.name ?? basename(agentDir);
  }

  return {
    routes,
    dynamicRoutes,
    resourceRoutes,
    layoutChains,
    layoutBoundaries,
    loadings,
    document: frozen.document,
    agent: frozen.agent,
    agentName,
    i18n: frozen.i18n,
    earlyHints: frozen.earlyHints,
    extra,
  };
}
