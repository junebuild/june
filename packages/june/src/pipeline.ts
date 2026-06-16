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

import React, { Suspense, use } from "react";
// renderToReadableStream (NOT renderToStaticMarkup): it is the ONE render
// function present in every react-dom/server build — node, browser, AND edge.
// workerd resolves react-dom/server to server.edge (server.browser needs
// MessageChannel), which exports only the streaming API (reminder #3). Using it
// on both dev and worker keeps the bundle workerd-ready AND byte-equivalent.
import { renderToReadableStream } from "react-dom/server";

import {
  LoaderDataContext,
  type BrandedRoute,
  type Metadata,
  type RenderTarget,
  type RouteContext,
} from "@junejs/core/route";
import { Document, type DocumentConfig } from "@junejs/core/document";
import {
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
  mcpServerCard,
  robotsTxt,
  sitemapXml,
} from "@junejs/core/discovery";
import { mcpHandler, mcpTools } from "@junejs/core/mcp";

import { ensureScope, runInScope } from "@junejs/db";
import type { AgentConfig } from "@junejs/core/config";
import {
  LOCALE_COOKIE,
  localeDir,
  matchPinnedLocale,
  negotiateLocale,
  type I18nConfig,
} from "@junejs/core/i18n";
import type { Resources } from "@junejs/core/resources";

import { negotiate, TITLE_HEADER, SEGMENT_HEADER } from "./negotiate";

// Minimal Cookie-header read for the locale negotiation chain (no dependency on
// an auth/cookie integration — i18n must stand alone).
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export type LayoutComponent = React.ComponentType<{ children: React.ReactNode }>;
export type LoadingComponent = React.ComponentType;

// What a resolver returns for a matched pathname: the route definition, its
// params, and the layout chain (root→leaf) that wraps it.
export type Resolved = {
  def: BrandedRoute;
  params: Record<string, string>;
  chain: LayoutComponent[];
  // The nearest loading.tsx up the segment chain. Its presence opts a route
  // into streaming Suspense: the shell + this fallback flush before load()
  // resolves, then the view streams in.
  loading?: React.ComponentType;
  // Segment-scoped fragments: the index in `chain` of the boundary layout (the
  // one exporting `segmentBoundary` and rendering <JuneOutlet>), deepest wins.
  // A soft-nav fragment then renders only chain.slice(boundaryIndex + 1) — the
  // boundary layout's own markup (the persistent shell) is NOT re-rendered.
  // null/undefined → whole-chain fragment (the default). Full documents always
  // render the whole chain regardless, so a hard load is unaffected.
  boundaryIndex?: number | null;
  // The shell's identity key (which boundary layout owns it). Stamped on
  // [data-june-root] (full load) and sent as the SEGMENT_HEADER (fragment) so the
  // client morphs a fragment only into the shell it belongs to. Set iff boundaryIndex is.
  boundaryKey?: string | null;
};

// A RESOURCE route (app/**/route.*): a handler returning a raw Response — binary,
// custom content-type, webhook — resolved by the SAME matcher (params from the
// path), so it lives in the route table instead of a hand-rolled url branch.
export type ResourceHandler = (
  request: Request,
  ctx: RouteContext,
) => Response | Promise<Response>;
export type ResolvedResource = { handler: ResourceHandler; params: Record<string, string> };

// The one thing dev and worker do differently: turn a clean pathname into a
// matched route. Dev walks the filesystem; the worker reads the frozen manifest.
// A match is either a page (Resolved) or a resource route (ResolvedResource).
export type RouteResolver = (pathname: string) => Promise<Resolved | ResolvedResource | null>;

export type PipelineConfig = {
  docConfig: DocumentConfig;
  agent: AgentConfig;
  // Locale routing config (june.config.ts `i18n`). Absent → no locale handling:
  // the resolution step below never runs and ctx.locale stays undefined.
  i18n?: I18nConfig;
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

// app/_middleware.* default export. Runs after the agent surface, before route
// resolution; return null to pass through, a Response to short-circuit.
//   ⚠ Don't authorize here — authorization is the single defineAction
//     run(input, ctx) gate; a check here is a second, ungoverned path.
//   ⚠ It runs BEFORE routes, so over-broad url matching shadows a page. For a
//     custom endpoint (binary, webhook) prefer a route.* resource route.
export type MiddlewareHandler = (
  request: Request,
  url: URL,
) => Promise<Response | null> | Response | null;
/** @deprecated the former name (app/_extra); use {@link MiddlewareHandler}. */
export type ExtraHandler = MiddlewareHandler;

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

// Make loader data available to the view's descendants via useLoaderData(). The
// view itself receives data as PROPS (canonical); this provider is the escape
// hatch for deep children and the Remix-style `const data = useLoaderData()`.
function provideLoaderData(data: unknown, node: React.ReactNode): React.ReactNode {
  return React.createElement(LoaderDataContext.Provider, { value: data }, node);
}

// The suspending leaf of a streaming route: use() the load promise, then render
// the view. While the promise is pending the component suspends, so React emits
// the surrounding Suspense fallback (loading.tsx) in the shell.
function StreamedView({
  loadPromise,
  def,
  ctx,
}: {
  loadPromise: Promise<unknown>;
  def: BrandedRoute;
  ctx: RouteContext;
}): React.ReactNode {
  const data = use(loadPromise);
  return provideLoaderData(data, def.view ? def.view(data, ctx) : null);
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

  // The document language + writing direction for one render. lang = the resolved
  // locale (ctx.locale) when i18n is on, else the site.lang floor, else "en"; dir
  // derives from it (a LocaleConfig.dir override wins). LTR → dir undefined, so
  // single-locale pages stay byte-identical.
  function langDir(locale: string | undefined): { lang: string; dir?: "ltr" | "rtl" } {
    const lang = locale ?? docConfig.site.lang ?? "en";
    return { lang, dir: localeDir(lang, cfg.i18n) };
  }

  async function renderDocument(
    node: React.ReactNode,
    metadata: Metadata | undefined,
    status: number,
    chain: LayoutComponent[],
    locale?: string,
    boundaryKey?: string | null,
  ): Promise<Response> {
    // Wrap root→leaf: chain[0] is outermost.
    const wrapped = chain.reduceRight<React.ReactNode>(
      (acc, L) => React.createElement(L, null, acc),
      node,
    );
    const stream = await renderToReadableStream(
      React.createElement(Document, {
        config: docConfigForRender(),
        metadata,
        children: wrapped,
        shellKey: boundaryKey, // stamps data-june-shell on [data-june-root]
        ...langDir(locale),
      }),
    );
    await stream.allReady; // fully resolved markup (no streamed Suspense fallbacks)
    // React 19 emits <!DOCTYPE html> itself for an <html> root — don't prepend a
    // second one.
    return new Response(stream, { status, headers: htmlHeaders() });
  }

  // Route A: the [data-june-root] inner HTML for a soft-nav / live-apply request
  // — the chain-wrapped view rendered WITHOUT the Document shell, so it is
  // byte-identical to what a full load puts inside [data-june-root] (the morph
  // parity contract). The title rides back in a header so the client updates
  // document.title without parsing the body. allReady (no streamed fallback) so
  // the applied DOM is complete.
  async function renderFragment(
    node: React.ReactNode,
    metadata: Metadata | undefined,
    chain: LayoutComponent[],
    boundaryIndex?: number | null,
    boundaryKey?: string | null,
  ): Promise<Response> {
    // ONE gate: a fragment is segment-scoped iff it has both a boundary index AND
    // a shell key. They always travel together (resolveBoundary returns both or
    // neither), but tying the content-slice and the header to a single flag means
    // a content-only body can never go out without its key (which would wipe the
    // shell) nor a key without a content-only body.
    const segmented = typeof boundaryIndex === "number" && boundaryKey != null;
    // Segment-scoped renders ONLY the chain below the boundary layout (its
    // children = the <JuneOutlet> contents on a full load), so the boundary
    // layout's shell markup is never produced. Whole-chain wraps the entire chain.
    const inside = segmented ? chain.slice(boundaryIndex! + 1) : chain;
    const wrapped = inside.reduceRight<React.ReactNode>(
      (acc, L) => React.createElement(L, null, acc),
      node,
    );
    const stream = await renderToReadableStream(wrapped);
    await stream.allReady;
    const html = await new Response(stream).text();
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const title = typeof metadata?.title === "string" ? metadata.title : undefined;
    if (title) headers.set(TITLE_HEADER, title);
    // The shell key tells the client which shell this content-only fragment is
    // for; it morphs the outlet only when that matches the mounted shell.
    if (segmented) headers.set(SEGMENT_HEADER, boundaryKey!);
    return new Response(html, { status: 200, headers });
  }

  // WebMCP: register the app's actions as browser tools. Computed per render
  // from the live registry (stable after warmup), gated on agent.webmcp + mcp
  // (execute proxies to /mcp). No actions → no script → page stays zero-JS.
  function docConfigForRender(): DocumentConfig {
    const webmcpTools = agent.webmcp && agent.mcp ? mcpTools() : null;
    return webmcpTools?.length ? { ...docConfig, webmcpTools } : docConfig;
  }

  // Streaming Suspense: the shell (layout chain + the loading.tsx fallback)
  // flushes immediately; <StreamedView> use()s the load promise, so React
  // streams the resolved view in once load() settles. Gated by the caller on
  // a present loading.tsx AND static metadata (a data-derived <title> can't
  // stream — the <head> is outside the boundary).
  async function renderStreamingDocument(
    resolved: Resolved,
    loadPromise: Promise<unknown>,
    ctx: RouteContext,
  ): Promise<Response> {
    const { def, chain, loading: Loading, boundaryKey } = resolved;
    const leaf = React.createElement(StreamedView, { loadPromise, def, ctx });
    const boundary = React.createElement(
      Suspense,
      { fallback: Loading ? React.createElement(Loading) : null },
      leaf,
    );
    const wrapped = chain.reduceRight<React.ReactNode>(
      (acc, L) => React.createElement(L, null, acc),
      boundary,
    );
    const metadata = typeof def.metadata === "object" ? def.metadata : undefined;
    const stream = await renderToReadableStream(
      React.createElement(Document, {
        config: docConfigForRender(),
        metadata,
        children: wrapped,
        shellKey: boundaryKey, // stamps data-june-shell on [data-june-root]
        ...langDir(ctx.locale),
      }),
      { onError: (e: unknown) => console.error("[june] streaming render error:", e) },
    );
    // NO allReady — return the live stream (shell first). React 19 streams the
    // <!DOCTYPE html> as the first bytes, so nothing to prepend.
    return new Response(stream, { status: 200, headers: htmlHeaders() });
  }

  function notFoundResponse(
    target: RenderTarget,
    pathname: string,
    locale?: string,
  ): Promise<Response> | Response {
    // Data clients get a JSON 404; humans get the rendered NotFound document.
    return target !== "view"
      ? Response.json({ error: "Not Found", path: pathname }, { status: 404 })
      : renderDocument(
          React.createElement(NotFound, { pathname }),
          { title: "Not found", robots: "noindex" },
          404,
          [],
          locale,
        );
  }

  function resolveMeta(def: BrandedRoute, data: unknown, ctx: RouteContext): Metadata | undefined {
    return typeof def.metadata === "function"
      ? (def.metadata as (d: unknown, c: RouteContext) => Metadata)(data, ctx)
      : def.metadata;
  }

  async function renderMarkdown(def: BrandedRoute, data: unknown, ctx: RouteContext): Promise<Response> {
    // md fn → custom; absent → derive from the json projection (loader data when
    // json is also absent). md/json === false is handled as 404 by the caller.
    const jsonData =
      typeof def.json === "function" ? await def.json(data, ctx) : def.json === false ? null : data;
    const body =
      typeof def.md === "function"
        ? await def.md(data, ctx)
        : "```json\n" + JSON.stringify(jsonData, null, 2) + "\n```\n";
    // x-markdown-tokens: a rough estimate (~4 chars/token) agents use to budget.
    return text(body, "text/markdown; charset=utf-8", {
      headers: { "x-markdown-tokens": String(Math.ceil(body.length / 4)) },
    });
  }

  async function renderProjection(
    resolved: Resolved,
    target: RenderTarget,
    data: unknown,
    ctx: RouteContext,
  ): Promise<Response> {
    const { def, chain, boundaryIndex, boundaryKey } = resolved;
    // A projection declared `false` is disabled → 404 (and absent from discovery).
    // "fragment" isn't a declarable projection (it's the view rendered without the
    // shell), so it's never disabled — exclude it from the check.
    if (target !== "fragment" && def[target] === false) {
      return notFoundResponse(target, ctx.url.pathname, ctx.locale);
    }

    const res = await renderTarget(target, def, data, ctx, chain, boundaryIndex, boundaryKey);
    // Every projection here is chosen by the Accept header at the SAME url (a full
    // page, its fragment, its .md and .json all live at the clean path). Without
    // Vary, a shared/browser cache can hand a soft-nav fragment to a real page
    // load — which surfaces as a document that starts mid-body. Make Accept part
    // of the cache key.
    res.headers.set("vary", "accept");
    return res;
  }

  async function renderTarget(
    target: RenderTarget,
    def: Resolved["def"],
    data: unknown,
    ctx: RouteContext,
    chain: LayoutComponent[],
    boundaryIndex?: number | null,
    boundaryKey?: string | null,
  ): Promise<Response> {
    if (target === "md") return renderMarkdown(def, data, ctx);
    if (target === "json") {
      // Convention: a json() fn customizes; absent → serialize the loader data.
      const payload = typeof def.json === "function" ? await def.json(data, ctx) : data;
      return Response.json(payload);
    }
    const node = provideLoaderData(data, def.view ? def.view(data, ctx) : null);
    const meta = resolveMeta(def, data, ctx);
    // Only the fragment projection narrows to a segment; the full document always
    // renders the whole chain (a hard load of the URL is never segment-scoped) —
    // but it stamps the shell key so the client knows which shell is mounted.
    if (target === "fragment") return renderFragment(node, meta, chain, boundaryIndex, boundaryKey);
    return renderDocument(node, meta, 200, chain, ctx.locale, boundaryKey);
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

  async function handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // --- agent surface ---------------------------------------------------
      if (url.pathname === "/mcp") {
        if (!agent.mcp) return notFoundResponse("view", url.pathname);
        // The agent's tool calls run inside the same request scope, so an action's
        // ambient `db` is the SAME resource the UI uses (and, once auth is wired,
        // the same principal via ctx). ctx carries identity only — not resources.
        return mcpHandler(request, { request });
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

      // --- locale resolution (before routing) ------------------------------
      // host/path → locale, stripping the locale prefix off the front so the
      // router matches the bare route path. Only runs when `i18n` is configured.
      let locale: string | undefined;
      let routeBase = url.pathname;
      if (cfg.i18n) {
        const pinned = matchPinnedLocale(cfg.i18n, url.host, url.pathname);
        if (pinned) {
          locale = pinned.locale;
          routeBase = pinned.pathname;
        } else {
          // Ambiguous (bare path on the default origin): the resolveLocale hook
          // gets first say, then the built-in chain. The hook runs ONLY here —
          // never when the URL already pinned the locale.
          const override = cfg.i18n.resolveLocale?.({ url, headers: request.headers });
          locale =
            override && cfg.i18n.locales[override]
              ? override
              : negotiateLocale(cfg.i18n, {
                  acceptLanguage: request.headers.get("accept-language"),
                  cookie: readCookie(request, LOCALE_COOKIE),
                });
        }
      }

      // --- routes ----------------------------------------------------------
      const { target, pathname, speculative } = negotiate(url, request, routeBase);
      const resolved = await cfg.resolve(pathname);
      if (!resolved) return notFoundResponse(target, pathname, locale);

      // ctx is identity/request only; db/kv/blob are ambient (read from the
      // request scope this whole handler runs inside — see runInScope below).
      const ctx: RouteContext = {
        request,
        url,
        params: resolved.params,
        target,
        locale,
        speculative,
      };

      // Resource route (route.*): a raw-Response handler — no projection, no doc
      // shell. It's matched like any route, so it can't shadow a page.
      if ("handler" in resolved) return resolved.handler(request, ctx);
      // Streaming Suspense: a view request on a route with loading.tsx AND
      // static metadata flushes the shell + fallback before load() resolves.
      // (data-derived metadata can't stream — the <head> needs the title.)
      if (target === "view" && resolved.loading && typeof resolved.def.metadata !== "function") {
        const loadPromise = Promise.resolve(
          resolved.def.load ? resolved.def.load(ctx) : undefined,
        );
        return renderStreamingDocument(resolved, loadPromise, ctx);
      }

      let data: unknown;
      try {
        data = resolved.def.load ? await resolved.def.load(ctx) : undefined;
      } catch {
        // unknown slug etc. → 404 (segment error boundaries are a later milestone)
        return notFoundResponse(target, pathname, locale);
      }
      return renderProjection(resolved, target, data, ctx);
  }

  return {
    async fetch(request: Request): Promise<Response> {
      // Open the request's resources (memoized; env-bound on workerd) and run the
      // ENTIRE request inside the scope, so ambient db/kv/blob resolve to them in
      // loaders, views, and /mcp actions alike. ensureScope() lazily wires the
      // async-context provider on first request (no static node:* import).
      await ensureScope();
      const resources = cfg.resources ? await cfg.resources() : {};
      return runInScope({ resources }, () => handleRequest(request));
    },
  };
}
