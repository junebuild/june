// The built worker's runtime — what `june build` GENERATES an entry for.
// workerd has no filesystem, so everything the dev server discovers at request
// time (routes, config, content, layout chains) arrives here as a FROZEN
// manifest built at build time. createWorker() feeds that manifest to the SAME
// render core the dev server uses (pipeline.ts) — so the built surfaces are
// byte-equivalent to dev (test/parity.test.ts proves it), not a re-implementation.
//
// Worker-safe by construction: this file + pipeline.ts touch only @junejs/core +
// react. The content pipeline's fs reads are frozen into the manifest at build,
// never run here.

import type React from "react";

import type { BrandedRoute } from "@junejs/core/route";
import type { AgentConfig } from "@junejs/core/config";
import type { DocumentConfig } from "@junejs/core/document";
import type { Resources } from "@junejs/core/resources";

import { createPipeline, type LayoutComponent, type Resolved } from "./pipeline";

export type WorkerManifest = {
  // Static paths → route definitions ("/", "/users", ...).
  routes: Record<string, BrandedRoute>;
  // Dynamic patterns in file-route syntax ("/posts/[slug]", "/docs/[...path]").
  dynamicRoutes?: Array<{ pattern: string; def: BrandedRoute }>;
  // Layout chains (root→leaf) keyed by route path / dynamic pattern. The build
  // freezes the same chain the dev server loads from app/layout.* files.
  layoutChains?: Record<string, LayoutComponent[]>;
  document: DocumentConfig;
  agent: AgentConfig;
  // Preload Link values (config earlyHints + auto font hints), frozen at build.
  earlyHints?: string[];
  htmlCacheControl?: string;
  notFound?: React.ComponentType<{ pathname: string }>;
  // Opened data resources (db/kv/blob) injected onto ctx. On workerd the D1/KV/R2
  // bindings come from env per request, so the generated entry passes a provider.
  resources?: () => Promise<Resources> | Resources;
};

type Compiled = { regex: RegExp; names: string[]; def: BrandedRoute; pattern: string };

// "/posts/[slug]" | "/docs/[...path]" → matcher
function compilePattern(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      const ca = seg.match(/^\[\.\.\.(\w+)\]$/);
      if (ca) {
        names.push(ca[1]!);
        return "(.+)";
      }
      const p = seg.match(/^\[(\w+)\]$/);
      if (p) {
        names.push(p[1]!);
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}$`), names };
}

export function createWorker(manifest: WorkerManifest): { fetch(request: Request): Promise<Response> } {
  const dynamic: Compiled[] = (manifest.dynamicRoutes ?? []).map((d) => ({
    ...compilePattern(d.pattern),
    def: d.def,
    pattern: d.pattern,
  }));
  const routeList = [
    ...Object.keys(manifest.routes),
    ...(manifest.dynamicRoutes ?? []).map((d) => d.pattern),
  ].sort();

  const chainFor = (key: string): LayoutComponent[] => manifest.layoutChains?.[key] ?? [];

  return createPipeline({
    docConfig: manifest.document,
    agent: manifest.agent,
    routeList: () => routeList,
    earlyHints: manifest.earlyHints,
    htmlCacheControl: manifest.htmlCacheControl,
    notFoundComponent: manifest.notFound,
    resources: manifest.resources,
    resolve: async (pathname): Promise<Resolved | null> => {
      const staticDef = manifest.routes[pathname];
      if (staticDef) return { def: staticDef, params: {}, chain: chainFor(pathname) };
      for (const d of dynamic) {
        const m = pathname.match(d.regex);
        if (m) {
          const params = Object.fromEntries(d.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
          return { def: d.def, params, chain: chainFor(d.pattern) };
        }
      }
      return null;
    },
  });
}
