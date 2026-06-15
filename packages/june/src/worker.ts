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

import { createPipeline, type ExtraHandler, type LayoutComponent, type LoadingComponent, type Resolved } from "./pipeline";

export type WorkerManifest = {
  // Static paths → route definitions ("/", "/users", ...).
  routes: Record<string, BrandedRoute>;
  // Dynamic patterns in file-route syntax ("/posts/[slug]", "/docs/[...path]").
  dynamicRoutes?: Array<{ pattern: string; def: BrandedRoute }>;
  // Layout chains (root→leaf) keyed by route path / dynamic pattern. The build
  // freezes the same chain the dev server loads from app/layout.* files.
  layoutChains?: Record<string, LayoutComponent[]>;
  // Nearest loading.tsx per route path → streaming Suspense fallback.
  loadings?: Record<string, LoadingComponent>;
  document: DocumentConfig;
  agent: AgentConfig;
  // Preload Link values (config earlyHints + auto font hints), frozen at build.
  earlyHints?: string[];
  htmlCacheControl?: string;
  notFound?: React.ComponentType<{ pathname: string }>;
  // The app/_extra.* pre-route handler, imported by the generated entry.
  extra?: ExtraHandler;
  // Opened data resources (db/kv/blob) injected onto ctx. On workerd the D1/KV/R2
  // bindings come from env, so the generated entry passes an ENV-AWARE provider
  // (bindWorkerResources) — the worker threads its env through on each fetch.
  resources?: (env?: unknown) => Promise<Resources> | Resources;
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

export function createWorker(
  manifest: WorkerManifest,
): { fetch(request: Request, env?: unknown): Promise<Response> } {
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
  const loadingFor = (key: string): LoadingComponent | undefined => manifest.loadings?.[key];

  // The worker's env (D1/KV/R2 bindings) arrives per fetch and is stable across
  // requests in an isolate; we capture the latest and hand it to the env-aware
  // provider, which memoizes the opened handles on first call.
  let currentEnv: unknown;
  const provider = manifest.resources;

  const pipeline = createPipeline({
    docConfig: manifest.document,
    agent: manifest.agent,
    routeList: () => routeList,
    earlyHints: manifest.earlyHints,
    htmlCacheControl: manifest.htmlCacheControl,
    notFoundComponent: manifest.notFound,
    extra: manifest.extra,
    resources: provider ? () => provider(currentEnv) : undefined,
    resolve: async (pathname): Promise<Resolved | null> => {
      const staticDef = manifest.routes[pathname];
      if (staticDef)
        return { def: staticDef, params: {}, chain: chainFor(pathname), loading: loadingFor(pathname) };
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
          return { def: d.def, params, chain: chainFor(d.pattern), loading: loadingFor(d.pattern) };
        }
      }
      return null;
    },
  });

  return {
    fetch(request, env) {
      currentEnv = env;
      return pipeline.fetch(request);
    },
  };
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
type FetchPipeline = { fetch(request: Request, env?: unknown): Promise<Response> };

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

      // 2. Static assets (prerendered HTML/.md/.json, /client.js, hashed CSS)
      //    served direct.
      if (assets) {
        const a = await assets.fetch(request);
        if (a.status !== 404) {
          const ct = a.headers.get("content-type") ?? "";
          const addLink = !!opts.link && ct.includes("text/html") && !a.headers.has("link");
          // Content-hashed assets (e.g. /global.<hash>.css) are immutable — the
          // URL changes when the bytes do, so the browser may cache forever and
          // never revalidate (no 304 round-trip, no stale window).
          const immutable = /\.[a-f0-9]{8,}\.(css|js)$/.test(url.pathname);
          if (addLink || immutable) {
            const headers = new Headers(a.headers);
            if (addLink) headers.set("link", opts.link!);
            if (immutable) headers.set("cache-control", "public, max-age=31536000, immutable");
            return new Response(a.body, { status: a.status, headers });
          }
          return a;
        }
      }

      // 3. Dynamic routes → the render pipeline (already sets Link + negotiates).
      // Env flows through so the pipeline's resources get the D1/KV/R2 bindings.
      return pipeline.fetch(request, env);
    },
  };
}

// The Deno-target twin of withAssets. Deno Deploy has NO CDN / asset binding, so
// the handler serves the hashed framework assets (/_june/*) from the bundle's
// co-located assets/ dir and falls through to the pipeline for everything else —
// the same split vercel() gets from the CDN, but in-process. The deno() adapter
// bakes `Deno.serve(withDenoAssets(pipeline))` into the entry. Deno globals are
// referenced only inside the body, so non-Deno bundles tree-shake this out.
declare const Deno: {
  readFile(path: string | URL): Promise<Uint8Array>;
};

const ASSET_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
};

export function withDenoAssets(pipeline: FetchPipeline): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/_june/")) {
      try {
        const file = await Deno.readFile(new URL(`./assets${url.pathname}`, import.meta.url));
        const ext = url.pathname.split(".").pop()?.toLowerCase() ?? "";
        return new Response(file as BodyInit, {
          headers: {
            "content-type": ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      } catch {
        /* not on disk → fall through (the pipeline 404s) */
      }
    }
    // No env arg: Deno has no platform bindings (unlike D1/KV on workers); env-
    // driven resources (turso) read process.env / Deno.env themselves. Keeps the
    // function off the --allow-env permission too.
    return pipeline.fetch(request);
  };
}
