// THE render core — ONE funnel shared by the dev server (app.ts, fs-driven) and
// the built worker (worker.ts, manifest-driven). The PoC wrote this pipeline
// TWICE (server.tsx + worker.tsx) and the copies drifted: the title-template
// and charset parity bugs only surfaced because dogfood pages happened to hit
// them. Here both callers delegate to the same code, so byte-equivalence is
// structural — the golden parity test (test/parity.test.ts) proves it.
//
// Worker-safe: @junejs/core (pure) + react + react-dom/server only. No node:*, no
// Bun.* — the dev-only and worker-only concerns (fs route discovery vs frozen
// manifest) are injected as a RouteResolver, not branched on here.

import React from "react";
// renderToReadableStream (NOT renderToStaticMarkup): it is the ONE render
// function present in every react-dom/server build — node, browser, AND edge.
// workerd resolves react-dom/server to server.edge (server.browser needs
// MessageChannel), which exports only the streaming API (reminder #3). Using it
// on both dev and worker keeps the bundle workerd-ready AND byte-equivalent.
import { renderToReadableStream } from "react-dom/server";

import {
  resolveProjection,
  type BrandedRoute,
  type Metadata,
  type RenderTarget,
  type RouteContext,
} from "@junejs/core/route";
import { Document, type DocumentConfig } from "@junejs/core/document";
import { isResourceManifest } from "@junejs/core/agent";
import {
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
  mcpServerCard,
  robotsTxt,
  sitemapXml,
} from "@junejs/core/discovery";
import { mcpHandler } from "@junejs/core/mcp";
import type { AgentConfig } from "@junejs/core/config";
import type { Resources } from "@junejs/core/resources";

import { negotiate } from "./negotiate";

export type LayoutComponent = React.ComponentType<{ children: React.ReactNode }>;

// What a resolver returns for a matched pathname: the route definition, its
// params, and the layout chain (root→leaf) that wraps it.
export type Resolved = {
  def: BrandedRoute;
  params: Record<string, string>;
  chain: LayoutComponent[];
};

// The one thing dev and worker do differently: turn a clean pathname into a
// matched route. Dev walks the filesystem; the worker reads the frozen manifest.
export type RouteResolver = (pathname: string) => Promise<Resolved | null>;

export type PipelineConfig = {
  docConfig: DocumentConfig;
  agent: AgentConfig;
  // The route list for discovery surfaces (sitemap / llms.txt). Async so dev can
  // re-scan the filesystem; the worker returns a frozen array.
  routeList: () => Promise<string[]> | string[];
  resolve: RouteResolver;
  // Opened data resources (db/kv/blob) injected onto ctx before load(). A
  // provider so opening is lazy/memoized; absent → no resources on ctx.
  resources?: () => Promise<Resources> | Resources;
  earlyHints?: string[];
  htmlCacheControl?: string;
  notFoundComponent?: React.ComponentType<{ pathname: string }>;
  // The app's pre-route escape hatch (app/_extra.*): runs after the agent
  // surface, before route resolution. Return null to fall through. For
  // responses route() can't express yet (binary, custom content types) —
  // e.g. an og:image PNG route.
  extra?: ExtraHandler;
};

export type ExtraHandler = (
  request: Request,
  url: URL,
) => Promise<Response | null> | Response | null;

export type Pipeline = { fetch(request: Request): Promise<Response> };

const DefaultNotFound: React.ComponentType<{ pathname: string }> = ({ pathname }) =>
  React.createElement(
    "main",
    null,
    React.createElement("h1", null, "404 — Not found"),
    React.createElement("p", null, pathname),
  );

function text(body: string, contentType: string, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", contentType);
  return new Response(body, { ...init, headers });
}

// The default favicon: the site name's first character in a rounded square —
// a plain SVG string, so it needs no fonts, no rasterizer, and works for CJK
// names as readily as latin ones. Served at /favicon.svg AND /favicon.ico
// (browsers respect the svg content-type), so no June app 404s its icon.
function letterFavicon(siteName: string | undefined): Response {
  const first = (siteName ?? "").trim().charAt(0) || "•";
  const letter = first.toUpperCase().replace(/[<>&"']/g, "");
  return text(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="12" fill="#1d1d1f"/>` +
      `<text x="32" y="32" dy=".36em" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="34" font-weight="600" fill="#fbfbf8">${letter || "•"}</text>` +
      `</svg>\n`,
    "image/svg+xml",
    { headers: { "cache-control": "public, max-age=86400" } },
  );
}

export function createPipeline(cfg: PipelineConfig): Pipeline {
  const { docConfig, agent } = cfg;
  const NotFound = cfg.notFoundComponent ?? DefaultNotFound;

  function htmlHeaders(): Headers {
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const links = [buildLinkHeader(agent), ...(cfg.earlyHints ?? [])].filter(Boolean) as string[];
    if (links.length) headers.set("link", links.join(", "));
    if (cfg.htmlCacheControl) headers.set("cache-control", cfg.htmlCacheControl);
    return headers;
  }

  async function renderDocument(
    node: React.ReactNode,
    metadata: Metadata | undefined,
    status: number,
    chain: LayoutComponent[],
  ): Promise<Response> {
    // Wrap root→leaf: chain[0] is outermost.
    const wrapped = chain.reduceRight<React.ReactNode>(
      (acc, L) => React.createElement(L, null, acc),
      node,
    );
    const stream = await renderToReadableStream(
      React.createElement(Document, { config: docConfig, metadata, children: wrapped }),
    );
    await stream.allReady; // fully resolved markup (no streamed Suspense fallbacks)
    const html = "<!doctype html>\n" + (await new Response(stream).text());
    return new Response(html, { status, headers: htmlHeaders() });
  }

  function notFoundResponse(target: RenderTarget, pathname: string): Promise<Response> | Response {
    // Data clients get a JSON 404; humans get the rendered NotFound document.
    return target !== "view"
      ? Response.json({ error: "Not Found", path: pathname }, { status: 404 })
      : renderDocument(
          React.createElement(NotFound, { pathname }),
          { title: "Not found", robots: "noindex" },
          404,
          [],
        );
  }

  function resolveMeta(def: BrandedRoute, data: unknown, ctx: RouteContext): Metadata | undefined {
    return typeof def.metadata === "function"
      ? (def.metadata as (d: unknown, c: RouteContext) => Metadata)(data, ctx)
      : def.metadata;
  }

  async function renderMarkdown(def: BrandedRoute, data: unknown, ctx: RouteContext): Promise<Response> {
    if (def.md) return text(await def.md(data, ctx), "text/markdown; charset=utf-8");
    const payload = def.json ? await def.json(data, ctx) : data;
    return text("```json\n" + JSON.stringify(payload, null, 2) + "\n```\n", "text/markdown; charset=utf-8");
  }

  async function renderProjection(
    resolved: Resolved,
    target: RenderTarget,
    data: unknown,
    ctx: RouteContext,
  ): Promise<Response> {
    const { def, chain } = resolved;
    if (target === "md") return renderMarkdown(def, data, ctx);

    switch (resolveProjection(def, target)) {
      case "json":
        return Response.json(await def.json!(data, ctx));
      case "agent": {
        const out = await def.agent!(data, ctx);
        const body = isResourceManifest(out) ? out.toManifest() : out;
        return text(JSON.stringify(body), "application/vnd.june-agent+json");
      }
      default: {
        const node = def.view ? def.view(data, ctx) : null;
        return renderDocument(node, resolveMeta(def, data, ctx), 200, chain);
      }
    }
  }

  async function discovery(url: URL): Promise<Response | null> {
    switch (url.pathname) {
      case "/llms.txt":
        return text(
          llmsTxt(url.origin, await cfg.routeList(), agent, docConfig.site),
          "text/markdown; charset=utf-8",
        );
      case "/robots.txt":
        return text(robotsTxt(url.origin), "text/plain; charset=utf-8");
      case "/sitemap.xml":
        return text(sitemapXml(url.origin, await cfg.routeList()), "application/xml; charset=utf-8");
      case "/.well-known/api-catalog":
        return text(JSON.stringify(apiCatalog(url.origin, agent)), "application/linkset+json");
      case "/.well-known/mcp/server-card.json":
        return agent.mcp ? Response.json(mcpServerCard(url.origin)) : null;
      default:
        return null;
    }
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // --- agent surface ---------------------------------------------------
      if (url.pathname === "/mcp") {
        if (!agent.mcp) return notFoundResponse("view", url.pathname);
        // The agent's tool calls run through the same resources (and, once auth
        // is wired, the same principal) the UI uses.
        const res = cfg.resources ? await cfg.resources() : undefined;
        return mcpHandler(request, { request, db: res?.db, kv: res?.kv, blob: res?.blob });
      }
      if (request.method === "GET" && agent.discovery) {
        const d = await discovery(url);
        if (d) return d;
      }

      // --- app escape hatch --------------------------------------------------
      // After the agent surface (framework-owned), before routes: the app can
      // claim any path the route conventions can't express yet.
      if (cfg.extra) {
        const out = await cfg.extra(request, url);
        if (out) return out;
      }

      // --- default favicon (after extra so an app can override it) ----------
      if (
        request.method === "GET" &&
        !docConfig.site.icon &&
        (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")
      ) {
        return letterFavicon(docConfig.site.name);
      }

      // --- routes ----------------------------------------------------------
      const { target, pathname, speculative } = negotiate(url, request);
      const resolved = await cfg.resolve(pathname);
      if (!resolved) return notFoundResponse(target, pathname);

      const res = cfg.resources ? await cfg.resources() : undefined;
      const ctx: RouteContext = {
        request,
        url,
        params: resolved.params,
        target,
        speculative,
        db: res?.db,
        kv: res?.kv,
        blob: res?.blob,
      };
      let data: unknown;
      try {
        data = resolved.def.load ? await resolved.def.load(ctx) : undefined;
      } catch {
        // unknown slug etc. → 404 (segment error boundaries are a later milestone)
        return notFoundResponse(target, pathname);
      }
      return renderProjection(resolved, target, data, ctx);
    },
  };
}
