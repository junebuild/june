// The request pipeline — the host-agnostic heart of the dev server (and the
// shape the built worker mirrors). Given an app directory and resolved config,
// `createApp()` returns a Web-standard `fetch(Request) => Response` that:
//
//   - serves the agent discovery surface (llms.txt / sitemap / robots /
//     api-catalog / mcp server-card) and the /mcp execution endpoint,
//   - matches a file route, runs its load(), and renders the negotiated
//     projection (view → SSR HTML · json · agent manifest · markdown),
//   - wraps every request in a trace so cache auto-tagging works.
//
// CONFIG IS LOAD-BEARING: every value below (site name, agent flags, view
// transitions, speculation) changes observable output. The dev server reading
// june.config.ts is verified by test/config-output.test.ts — the PoC shipped a
// dev server that silently ignored the config for days (rebuild-plan Phase 2).

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pathToFileURL } from "node:url";

import {
  isRouteDefinition,
  resolveProjection,
  type BrandedRoute,
  type Metadata,
  type RouteContext,
} from "junecore/route";
import {
  resolveAgent,
  resolveSpeculationRules,
  type JuneConfig,
} from "junecore/config";
import { Document, type DocumentConfig } from "junecore/document";
import { isResourceManifest } from "junecore/agent";
import {
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
  mcpServerCard,
  robotsTxt,
  sitemapXml,
} from "junecore/discovery";
import { mcpHandler } from "junecore/mcp";
import { runWithTrace, type RequestTrace } from "junecore/instrumentation";

import { listRoutes, matchRouteTree, routeFiles } from "./router";
import { negotiate } from "./negotiate";

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

function text(body: string, contentType: string, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", contentType);
  return new Response(body, { ...init, headers });
}

function newTrace(): RequestTrace {
  return { id: crypto.randomUUID(), startedAt: performance.now(), events: [] };
}

export function createApp({ appDir, config = {} }: CreateAppOptions): JuneApp {
  const agent = resolveAgent(config.agent);
  const site = config.site ?? {};
  const speculationRules = resolveSpeculationRules(config.speculation ?? undefined);
  const speculation = config.speculation;
  const speculationDelivery = speculation ? speculation.delivery ?? "inline" : "inline";
  const docConfig: DocumentConfig = {
    site,
    speculationRules,
    speculationDelivery,
    viewTransitions: config.viewTransitions ?? true,
  };

  const routePaths = () => listRoutes(appDir, { pageConvention: true });

  function resolveMeta(
    def: BrandedRoute,
    data: unknown,
    ctx: RouteContext,
  ): Metadata | undefined {
    return typeof def.metadata === "function"
      ? (def.metadata as (d: unknown, c: RouteContext) => Metadata)(data, ctx)
      : def.metadata;
  }

  function renderView(def: BrandedRoute, data: unknown, ctx: RouteContext): Response {
    const node = def.view ? def.view(data, ctx) : null;
    const html =
      "<!doctype html>\n" +
      renderToStaticMarkup(
        React.createElement(Document, {
          config: docConfig,
          metadata: resolveMeta(def, data, ctx),
          children: node,
        }),
      );
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const link = buildLinkHeader(agent);
    if (link) headers.set("link", link);
    if (speculationRules && speculationDelivery === "header") {
      headers.set("speculation-rules", `"/__june/speculation-rules"`);
    }
    return new Response(html, { headers });
  }

  async function renderMarkdown(
    def: BrandedRoute,
    data: unknown,
    ctx: RouteContext,
  ): Promise<Response> {
    if (def.md) return text(await def.md(data, ctx), "text/markdown; charset=utf-8");
    // Auto-derive: the .md target falls back to the json (or raw load) data,
    // fenced — so an agent asking for `.md` on a data route still gets markdown.
    const payload = def.json ? await def.json(data, ctx) : data;
    return text(
      "```json\n" + JSON.stringify(payload, null, 2) + "\n```\n",
      "text/markdown; charset=utf-8",
    );
  }

  async function renderProjection(
    def: BrandedRoute,
    target: RouteContext["target"],
    data: unknown,
    ctx: RouteContext,
  ): Promise<Response> {
    if (target === "md") return renderMarkdown(def, data, ctx);

    switch (resolveProjection(def, target)) {
      case "json":
        return Response.json(await def.json!(data, ctx));
      case "agent": {
        const out = await def.agent!(data, ctx);
        const body = isResourceManifest(out) ? out.toManifest() : out;
        return text(JSON.stringify(body), "application/vnd.june-agent+json");
      }
      default:
        return renderView(def, data, ctx);
    }
  }

  async function notFound(): Promise<Response> {
    const html =
      "<!doctype html>\n" +
      renderToStaticMarkup(
        React.createElement(Document, {
          config: docConfig,
          metadata: { title: "Not found" },
          children: React.createElement(
            "main",
            null,
            React.createElement("h1", null, "404 — Not found"),
          ),
        }),
      );
    return text(html, "text/html; charset=utf-8", { status: 404 });
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    // --- agent surface ----------------------------------------------------
    if (url.pathname === "/mcp") {
      if (!agent.mcp) return notFound();
      return mcpHandler(request);
    }
    if (request.method === "GET" && agent.discovery) {
      switch (url.pathname) {
        case "/llms.txt":
          return text(llmsTxt(origin, await routePaths(), agent, site), "text/markdown; charset=utf-8");
        case "/robots.txt":
          return text(robotsTxt(origin), "text/plain; charset=utf-8");
        case "/sitemap.xml":
          return text(sitemapXml(origin, await routePaths()), "application/xml; charset=utf-8");
        case "/.well-known/api-catalog":
          return text(JSON.stringify(apiCatalog(origin, agent)), "application/linkset+json");
        case "/.well-known/mcp/server-card.json":
          return agent.mcp ? Response.json(mcpServerCard(origin)) : notFound();
      }
    }

    // --- routes -----------------------------------------------------------
    const { target, pathname, speculative } = negotiate(url, request);
    const match = await matchRouteTree(appDir, pathname, { pageConvention: true });
    if (!match) return notFound();

    const mod = (await import(pathToFileURL(match.file).href)) as { default?: unknown };
    if (!isRouteDefinition(mod.default)) {
      return text(
        `Route ${match.file} has no route() default export`,
        "text/plain; charset=utf-8",
        { status: 500 },
      );
    }
    const def = mod.default;
    const ctx: RouteContext = { request, url, params: match.params, target, speculative };
    const data = def.load ? await def.load(ctx) : undefined;
    return renderProjection(def, target, data, ctx);
  }

  return {
    fetch(request) {
      return runWithTrace(newTrace(), () => dispatch(request));
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
