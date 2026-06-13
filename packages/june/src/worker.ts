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

import { createPipeline, type ExtraHandler, type LayoutComponent, type Resolved } from "./pipeline";

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
  // The app/_extra.* pre-route handler, imported by the generated entry.
  extra?: ExtraHandler;
  // Opened data resources (db/kv/blob) injected onto ctx. On workerd the D1/KV/R2
  // bindings come from env per request, so the generated entry passes a provider.
  resources?: () => Promise<Resources> | Resources;
};

type Compiled = { regex: RegExp; names: string[]; def: BrandedRoute; pattern: string };

// "/posts/[slug]" | "/docs/[...path]" | "/notes/[[tag]]" → matcher. Optional
// segments ([[x]], [[...x]]) wrap slash + capture together so absence matches;
// a pattern of ONLY optional segments must also match the bare "/".
function compilePattern(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  let source = "";
  let allOptional = true;
  for (const seg of pattern.split("/").filter(Boolean)) {
    const oca = seg.match(/^\[\[\.\.\.(\w+)\]\]$/);
    if (oca) {
      names.push(oca[1]!);
      source += "(?:/(.+))?";
      continue;
    }
    const ca = seg.match(/^\[\.\.\.(\w+)\]$/);
    if (ca) {
      names.push(ca[1]!);
      source += "/(.+)";
      allOptional = false;
      continue;
    }
    const op = seg.match(/^\[\[(\w+)\]\]$/);
    if (op) {
      names.push(op[1]!);
      source += "(?:/([^/]+))?";
      continue;
    }
    const p = seg.match(/^\[(\w+)\]$/);
    if (p) {
      names.push(p[1]!);
      source += "/([^/]+)";
      allOptional = false;
      continue;
    }
    source += "/" + seg.replace(/[.*+?^${}()|\\]/g, "\\$&");
    allOptional = false;
  }
  if (source === "") return { regex: /^\/$/, names };
  return { regex: new RegExp(allOptional ? `^(?:${source}|/)$` : `^${source}$`), names };
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
    extra: manifest.extra,
    resources: manifest.resources,
    resolve: async (pathname): Promise<Resolved | null> => {
      const staticDef = manifest.routes[pathname];
      if (staticDef) return { def: staticDef, params: {}, chain: chainFor(pathname) };
      for (const d of dynamic) {
        const m = pathname.match(d.regex);
        if (m) {
          // Optional segments leave their capture undefined — the param is
          // then absent, matching the dev matcher's semantics.
          const params = Object.fromEntries(
            d.names.flatMap((n, i) => {
              const v = m[i + 1];
              return v === undefined ? [] : [[n, decodeURIComponent(v)]];
            }),
          );
          return { def: d.def, params, chain: chainFor(d.pattern) };
        }
      }
      return null;
    },
  });
}

// --- the deployed worker's outermost layer (run_worker_first) ---------------
// Prerendered pages are served as static ASSETS, which bypass the pipeline —
// so the agent-ready signals the asset layer can't produce get added HERE:
//   1. `Accept: text/markdown` on a page → the prerendered `.md` asset.
//   2. a `Link` header on every HTML response (RFC 8288/9727 discovery).
//   3. `x-markdown-tokens` on markdown responses.
// Static assets are served by the ASSETS binding (no re-render); only genuinely
// dynamic routes reach the pipeline. With no ASSETS binding (no prerender), this
// is a transparent pass-through to the pipeline.
type AssetEnv = { ASSETS?: { fetch(request: Request): Promise<Response> } };
type FetchPipeline = { fetch(request: Request): Promise<Response> };

const estimateTokens = (s: string) => String(Math.ceil(s.length / 4));

export function withAssets(
  pipeline: FetchPipeline,
  opts: { link?: string | null } = {},
): { fetch(request: Request, env?: AssetEnv): Promise<Response> } {
  return {
    async fetch(request, env) {
      const assets = env?.ASSETS;
      const url = new URL(request.url);
      const isPagePath = !/\.[a-z0-9]+$/i.test(url.pathname); // no file extension
      const accept = request.headers.get("accept") ?? "";

      // 1. Markdown content negotiation on a page path → prerendered .md asset.
      if (assets && request.method === "GET" && isPagePath && /text\/markdown/.test(accept)) {
        const base = url.pathname === "/" ? "/index" : url.pathname.replace(/\/+$/, "");
        const mdUrl = new URL(url);
        mdUrl.pathname = `${base}.md`;
        const a = await assets.fetch(new Request(mdUrl.toString(), { headers: request.headers }));
        if (a.ok) {
          const body = await a.text();
          const headers = new Headers(a.headers);
          headers.set("content-type", "text/markdown; charset=utf-8");
          headers.set("x-markdown-tokens", estimateTokens(body));
          if (opts.link) headers.set("link", opts.link);
          return new Response(body, { status: 200, headers });
        }
        // no prerendered .md → fall through; a dynamic route renders it below.
      }

      // 2. Static assets (prerendered HTML/.md/.json, /client.js) served direct.
      if (assets) {
        const a = await assets.fetch(request);
        if (a.status !== 404) {
          const ct = a.headers.get("content-type") ?? "";
          if (opts.link && ct.includes("text/html") && !a.headers.has("link")) {
            const headers = new Headers(a.headers);
            headers.set("link", opts.link);
            return new Response(a.body, { status: a.status, headers });
          }
          return a;
        }
      }

      // 3. Dynamic routes → the render pipeline (already sets Link + negotiates).
      return pipeline.fetch(request);
    },
  };
}
