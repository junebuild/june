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
import { Document, documentTitle, pageCanonical, PRERENDER_ORIGIN, type DocumentConfig } from "@junejs/core/document";
import {
  AGENT_SKILLS_INDEX_PATH,
  AI_CATALOG_PATH,
  API_CATALOG_CONTENT_TYPE,
  ARD_PATH,
  agentSkillsIndex,
  aiCatalog,
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
  MCP_SERVER_CARD_TYPE,
  mcpServerCard,
  robotsTxt,
  siteSkill,
  sitemapXml,
} from "@junejs/core/discovery";
import { mcpHandler, mcpServerIdentity, mcpTools } from "@junejs/core/mcp";
import {
  apiActionId,
  apiHandler,
  apiNamespaceResponse,
  isApiNamespace,
  OPENAPI_MEDIA_TYPE,
  openApiDocument,
} from "@junejs/core/api";
import type { Principal, Session } from "@junejs/core/context";

import { ensureScope, runInScope, setRequestLocale } from "@junejs/db";
import type { AgentConfig } from "@junejs/core/config";
import {
  LOCALE_COOKIE,
  localeAlternates,
  localeDir,
  matchPinnedLocale,
  negotiateLocale,
  type I18nConfig,
  type LocaleAlternate,
} from "@junejs/core/i18n";
import type { Resources } from "@junejs/core/resources";

import { iconLetter } from "./icon-letter";
import { collectLlmsLinks, collectSitemapPages } from "./llms-links";
import { webManifest } from "./web-manifest";
import { negotiate, TITLE_HEADER, SEGMENT_HEADER, encodeTitle } from "./negotiate";

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
  // The durable agent surface (chat endpoint + inbound channels), mounted by the
  // caller from the agent/ directory (dev discovers it from fs; the worker from a
  // manifest/DO). Runs after the static agent surface (/mcp + discovery), before
  // middleware/routes. Returns null to fall through. Gated by agent.runtime.enabled.
  agentSurface?: MiddlewareHandler;
  // Locale routing config (june.config.ts `i18n`). Absent → no locale handling:
  // the resolution step below never runs and ctx.locale stays undefined.
  i18n?: I18nConfig;
  // The route list for discovery surfaces (sitemap / llms.txt). Async so dev can
  // re-scan the filesystem; the worker returns a frozen array.
  routeList: () => Promise<string[]> | string[];
  resolve: RouteResolver;
  // True only while the static() build prerenders: /sitemap.xml may then list a
  // dynamic route's `staticPaths`, which the route contract confines to that
  // build (they may do build-only or expensive work). At runtime a crawler's
  // /sitemap.xml enumerates dynamic pages from their `llms` entries alone.
  staticBuild?: boolean;
  // Opened data resources (db/kv/blob) injected onto ctx before load(). A
  // provider so opening is lazy/memoized; absent → no resources on ctx.
  resources?: () => Promise<Resources> | Resources;
  // The app-defined services bag, built from the isolate's env (config `services`).
  // A provider like `resources` (lazy/memoized); seeded into the request scope so
  // `currentServices()` resolves in loaders/views/actions. Absent → currentServices()
  // is undefined. This is the Worker-side twin of a Durable Object seeding services.
  services?: () => Promise<unknown> | unknown;
  // Resolve the request's authenticated identity (the auth integration's job —
  // e.g. Better Auth reading the session cookie). The result rides every
  // ActionContext the pipeline builds, starting with the /mcp mount, so
  // requiresPrincipal actions and per-call connection auth see the SAME
  // principal a UI dispatch would. Absent → anonymous (identity-gated actions
  // reject); a THROWING resolver propagates as a server error — it must never
  // silently degrade to anonymous.
  identity?: (request: Request) => Promise<{ user?: Principal; session?: Session }> | { user?: Principal; session?: Session };
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

// Catalogs crawlers and browser-based agents fetch cross-origin (ARD requires it).
const CORS = { "access-control-allow-origin": "*" };

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
// (browsers respect the svg content-type), so no June app 404s its icon. A built
// app also ships real PNG/ICO files (favicon.ts), which the asset layer answers
// first, so this /favicon.ico is only the fallback.
function letterFavicon(siteName: string | undefined): Response {
  const letter = (iconLetter(siteName) || "•").replace(/[<>&"']/g, "");
  return text(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="12" fill="#1d1d1f"/>` +
      `<text x="32" y="32" dy=".36em" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="34" font-weight="600" fill="#fbfbf8">${letter || "•"}</text>` +
      `</svg>\n`,
    "image/svg+xml",
    { headers: { "cache-control": "public, max-age=86400" } },
  );
}

// A page URL's markdown twin — the same paths `june build` prerenders: /index.md
// for the home page (and a locale home, /zh-cn/index.md), <path>.md otherwise.
// A trailing slash is dropped first: /users/ is the same page as /users, whose
// twin is the flat /users.md (never /users/index.md). A home reached through its
// /index alias (/index, /de/index) is the same home: /de/index → /de/index.md.
// Only a HOME folds /index — /docs/index is its own route, twin /docs/index.md.
export function markdownPath(pathname: string, isHome: boolean): string {
  const path = pathname.replace(/\/+$/, "");
  return isHome ? `${path.replace(/\/index$/, "")}/index.md` : `${path}.md`;
}

// The inverse: the path a page's HTML form lives at, for the markdown
// projection's canonical — /docs/x.md → /docs/x; for a home, its /index alias
// folds away (/index.md → /, /de/index.md and /de/index → /de). A non-home
// /docs/index(.md) stays /docs/index.
export function htmlPath(pathname: string, isHome: boolean): string {
  const path = pathname.endsWith(".md") ? pathname.slice(0, -3) : pathname;
  if (!isHome) return path;
  return path.replace(/\/+$/, "").replace(/\/index$/, "") || "/";
}

// The MCP Server Card's discovery contract (experimental-ext-server-card
// docs/discovery.md): its own media type (MCP_SERVER_CARD_TYPE, shared with the
// api-catalog and Link header), and CORS so browser clients can read it.
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";
const SERVER_CARD_CORS = {
  "access-control-allow-origin": "*",
  // HEAD too: the discovery gate answers it on every surface (same headers, no body).
  "access-control-allow-methods": "GET, HEAD",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
};

type PageProps = { pageUrl: string; isHome: boolean; onLocaleDomain: boolean; markdownHref?: string };

// A request's matched route pathname (locale stripped, /index → /), keyed by its
// ctx — RouteContext is public API, so the pipeline tracks it on the side.
const routePathOf = new WeakMap<RouteContext, string>();

// Whether every "/"-separated segment of a path percent-decodes (a malformed
// escape like "%ZZ" or a truncated UTF-8 sequence doesn't). The only thing
// decodeURIComponent can throw is URIError, so any failure means "no".
export function isDecodablePath(pathname: string): boolean {
  try {
    for (const segment of pathname.split("/")) decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
}

export function createPipeline(cfg: PipelineConfig): Pipeline {
  const { docConfig, agent } = cfg;
  const NotFound = cfg.notFoundComponent ?? DefaultNotFound;
  // The origin-independent half of catalogOrigin() below — all a response header
  // can know (a static build publishes no headers, so the prerender-origin half
  // never applies to one).
  const publishesCatalogs = agent.discovery && !docConfig.basePath;

  function htmlHeaders(): Headers {
    // Every pipeline document is one variant of an Accept-negotiated URL (its .md
    // and .json answer at the same path) — including streamed pages and the 404.
    const headers = new Headers({ "content-type": "text/html; charset=utf-8", vary: "accept" });
    const links = [buildLinkHeader(agent, { catalogs: publishesCatalogs }), ...(cfg.earlyHints ?? [])].filter(
      Boolean,
    ) as string[];
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

  // rel="alternate" hreflang links for this page's locale variants. Built from the
  // locale-STRIPPED route path (so every locale's URL is generated correctly) and
  // the current host (cross-origin locales come back absolute). undefined when
  // i18n is off → single-locale pages emit no hreflang.
  function alternatesFor(ctx: RouteContext): LocaleAlternate[] | undefined {
    if (!cfg.i18n) return undefined;
    const pinned = matchPinnedLocale(cfg.i18n, ctx.url.host, ctx.url.pathname);
    const routePath = pinned ? pinned.pathname : ctx.url.pathname;
    return localeAlternates(cfg.i18n, routePath, {
      currentHost: ctx.url.host,
      protocol: ctx.url.protocol.replace(":", ""),
    });
  }

  // The document's page-identity props: the URL for og:url/canonical, whether the
  // MATCHED route is home (so /de and /index count, per negotiate's normalized
  // pathname), and whether the host is a locale's own domain (its public origin).
  function pageProps(ctx: RouteContext, def: BrandedRoute): PageProps {
    const isHome = routePathOf.get(ctx) === "/";
    return {
      pageUrl: ctx.url.href,
      isHome,
      onLocaleDomain: onLocaleDomain(ctx),
      // The page's markdown twin, advertised as a discovery signal (so gated with
      // the rest of discovery). A disabled md projection gets no link to a 404.
      markdownHref: agent.discovery && def.md !== false ? markdownPath(ctx.url.pathname, isHome) : undefined,
    };
  }

  function onLocaleDomain(ctx: RouteContext): boolean {
    const host = ctx.url.hostname.toLowerCase();
    return cfg.i18n
      ? Object.values(cfg.i18n.locales).some((l) => l.domain?.toLowerCase() === host)
      : false;
  }

  async function renderDocument(
    node: React.ReactNode,
    metadata: Metadata | undefined,
    status: number,
    chain: LayoutComponent[],
    locale?: string,
    boundaryKey?: string | null,
    alternates?: LocaleAlternate[],
    page?: PageProps,
  ): Promise<Response> {
    // Wrap root→leaf: chain[0] is outermost.
    const wrapped = chain.reduceRight<React.ReactNode>(
      (acc, L) => React.createElement(L, null, acc),
      node,
    );
    const stream = await renderToReadableStream(
      React.createElement(Document, {
        config: docConfigForRender(page?.pageUrl),
        metadata,
        children: wrapped,
        shellKey: boundaryKey, // stamps data-june-shell on [data-june-root]
        alternates,
        ...page,
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
    // encodeTitle keeps the header ASCII-safe (a header value is Latin-1-only, but
    // titles carry CJK/accents/emoji); the client decodeTitles it before document.title.
    if (title) headers.set(TITLE_HEADER, encodeTitle(title));
    // The shell key tells the client which shell this content-only fragment is
    // for; it morphs the outlet only when that matches the mounted shell.
    if (segmented) headers.set(SEGMENT_HEADER, boundaryKey!);
    return new Response(html, { status: 200, headers });
  }

  // WebMCP: register the app's actions as browser tools. Computed per render
  // from the live registry (stable after warmup), gated on agent.webmcp + mcp
  // (execute proxies to /mcp). No actions → no script → page stays zero-JS.
  function docConfigForRender(pageUrl?: string): DocumentConfig {
    const webmcpTools = agent.webmcp && agent.mcp ? mcpTools() : null;
    // <link rel="ai-catalog"> — the AI Catalog spec's in-page pointer (ARD) —
    // only where this pipeline actually serves the catalog for the page's origin
    // (never under a basePath, never on a static build without a public origin).
    const servesCatalog = !!pageUrl && catalogOrigin(new URL(pageUrl)) !== null;
    return {
      ...docConfig,
      ...(webmcpTools?.length ? { webmcpTools } : {}),
      ...(servesCatalog ? { aiCatalog: AI_CATALOG_PATH } : {}),
    };
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
        config: docConfigForRender(ctx.url.href),
        metadata,
        children: wrapped,
        shellKey: boundaryKey, // stamps data-june-shell on [data-june-root]
        alternates: alternatesFor(ctx),
        ...pageProps(ctx, def),
        ...langDir(ctx.locale),
      }),
      { onError: (e: unknown) => console.error("[june] streaming render error:", e) },
    );
    // NO allReady — return the live stream (shell first). React 19 streams the
    // <!DOCTYPE html> as the first bytes, so nothing to prepend.
    return new Response(stream, { status: 200, headers: htmlHeaders() });
  }

  // Route resolution for a request path. Every resolver (the dev tree matcher,
  // the built worker's dynamic + resource tables) percent-decodes URL segments,
  // and would throw URIError on a malformed escape (/docs/%ZZ). Such a path can
  // match no route by definition, so it is refused BEFORE resolving — a miss
  // (the normal negotiated 404, or the API's JSON 404 under /api) — rather than
  // catching around cfg.resolve(), which also imports route modules: a genuine
  // error there, URIError included, must still surface. Checking each segment
  // suffices for every resolver: their captures are whole segments or runs of
  // them joined by "/", which decode iff each segment does.
  async function resolveRoute(pathname: string): ReturnType<RouteResolver> {
    return isDecodablePath(pathname) ? cfg.resolve(pathname) : null;
  }

  function notFoundResponse(
    target: RenderTarget,
    pathname: string,
    locale?: string,
    // Passed only when ROUTING found nothing (not when a matched route 404s): an
    // unmatched path in June's REST namespace (/api) is an API miss, answered
    // with the API's own JSON error/index whatever Accept negotiated — app
    // routes under /api were already given their chance.
    unmatched?: Request,
  ): Promise<Response> | Response {
    if (unmatched && agent.api) {
      const url = new URL(unmatched.url);
      if (isApiNamespace(url.pathname)) return apiNamespaceResponse(unmatched, url.origin);
    }
    // Agents get a 404 they can act on: Markdown for an Accept: text/markdown (or
    // .md) request, structured JSON for other data clients — both pointing at the
    // discovery surfaces. Humans get the rendered NotFound document. The body
    // depends on Accept, so every variant says so to caches.
    if (target === "md") {
      return discoveryLinks().then((links) =>
        text(notFoundMarkdown(pathname, links), "text/markdown; charset=utf-8", {
          status: 404,
          headers: { vary: "accept" },
        }),
      );
    }
    if (target !== "view") {
      return discoveryLinks().then((links) =>
        Response.json(
          { error: "Not Found", code: "not_found", path: pathname, hint: notFoundHint(links) },
          { status: 404, headers: { vary: "accept" } },
        ),
      );
    }
    return renderDocument(
      React.createElement(NotFound, { pathname }),
      { title: "Not found", robots: "noindex" },
      404,
      [],
      locale,
    );
  }

  // Where an agent that hit a dead end should look next — only surfaces this app
  // actually serves: /index.md only when a root page exists with its md live.
  async function discoveryLinks(): Promise<Array<[label: string, href: string]>> {
    const links: Array<[string, string]> = [];
    if (agent.discovery) {
      links.push(["llms.txt — the site index for agents", "/llms.txt"], ["sitemap.xml — every page", "/sitemap.xml"]);
    }
    if (agent.mcp) links.push(["MCP server — this site's tools", "/mcp"]);
    if (agent.api) links.push(["OpenAPI — the same tools over HTTP", "/openapi.json"]);
    const home = await cfg.resolve("/");
    if (home && "def" in home && home.def.md !== false) links.push(["Home page (Markdown)", "/index.md"]);
    return links;
  }

  function notFoundHint(links: Array<[string, string]>): string {
    return links.length
      ? `No page at this path. Start from ${links.map(([, h]) => h).join(", ")}.`
      : "No page at this path.";
  }

  function notFoundMarkdown(pathname: string, links: Array<[string, string]>): string {
    const site = docConfig.site.name ? ` on ${docConfig.site.name}` : "";
    return [
      "# 404 — Not found",
      "",
      links.length
        ? `There is no page at \`${pathname}\`${site}. Try one of these instead:`
        : `There is no page at \`${pathname}\`${site}.`,
      "",
      ...links.map(([label, href]) => `- [${label}](${href})`),
      "",
    ].join("\n");
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
    const content =
      typeof def.md === "function"
        ? await def.md(data, ctx)
        : "```json\n" + JSON.stringify(jsonData, null, 2) + "\n```\n";
    const body = withFrontmatter(content, resolveMeta(def, data, ctx), ctx);
    // x-markdown-tokens: a rough estimate (~4 chars/token) agents use to budget.
    return text(body, "text/markdown; charset=utf-8", {
      headers: { "x-markdown-tokens": String(Math.ceil(body.length / 4)) },
    });
  }

  // Open served markdown with a frontmatter block (title, description, canonical)
  // so an agent gets the page's metadata without scraping the HTML. A body that
  // already opens with its own frontmatter (e.g. a content file served verbatim)
  // is left alone. Values are JSON strings — valid YAML double-quoted scalars.
  function withFrontmatter(body: string, meta: Metadata | undefined, ctx: RouteContext): string {
    if (/^---\r?\n/.test(body)) return body;
    // The page's OWN title, not the templated <title> ("Users", not "Users · Site"):
    // the template is browser-tab branding, and authored frontmatter (served
    // verbatim) carries the bare title too — so every .md reads the same way. The
    // site name is only the fallback for a page with no title — an empty title
    // counts as none, exactly as documentTitle() treats it.
    const title = meta?.title || documentTitle(meta, docConfig.site);
    const description = meta?.description ?? docConfig.site.description;
    const canonical = pageCanonical(docConfig, meta, ctx.url.href, htmlPath(ctx.url.pathname, routePathOf.get(ctx) === "/"), onLocaleDomain(ctx));
    const lines = ["---", `title: ${JSON.stringify(title)}`];
    if (description) lines.push(`description: ${JSON.stringify(description)}`);
    if (canonical) lines.push(`canonical: ${JSON.stringify(canonical)}`);
    lines.push("---", "");
    return lines.join("\n") + body;
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
    return renderDocument(node, meta, 200, chain, ctx.locale, boundaryKey, alternatesFor(ctx), pageProps(ctx, def));
  }

  // The origin the agent catalogs name, or null when this site publishes none —
  // the single rule for serving them, prerendering them, and advertising them
  // (head link, Link header, robots Agentmap):
  //   • agent.discovery off → no discovery surface at all;
  //   • a basePath site doesn't own the domain root, where /.well-known lives;
  //   • a static build renders against the placeholder prerender host, which must
  //     never reach a published file: use the configured public origin (site.url,
  //     else deploy.domain) there, and publish nothing when neither is set.
  function catalogOrigin(url: URL): string | null {
    if (!publishesCatalogs) return null;
    if (url.origin !== PRERENDER_ORIGIN) return url.origin;
    return docConfig.site.url ? new URL(docConfig.site.url).origin : (docConfig.deployOrigin ?? null);
  }

  // The agent catalogs: Agent Skills (index + the generated SKILL.md) and the
  // ARD / AI Catalog. CORS-open — crawlers and browser agents fetch them cross-origin.
  async function agentCatalog(url: URL): Promise<Response | null> {
    const { pathname } = url;
    if (!pathname.startsWith("/.well-known/")) return null;
    const origin = catalogOrigin(url);
    if (!origin) return null;
    if (pathname === AGENT_SKILLS_INDEX_PATH) {
      return Response.json(await agentSkillsIndex(origin, agent, docConfig.site), { headers: CORS });
    }
    if (pathname === AI_CATALOG_PATH || pathname === ARD_PATH) {
      return Response.json(aiCatalog(origin, agent, docConfig.site), { headers: CORS });
    }
    // The skill's path carries its name; only the generated skill's own path answers.
    const skill = siteSkill(origin, agent, docConfig.site);
    if (pathname === new URL(skill.url).pathname) {
      return text(skill.markdown, "text/markdown; charset=utf-8", { headers: CORS });
    }
    // The skills directory is ours while we serve it: any other path under it is
    // a skill that doesn't exist, a 404 the RFC requires — never handed to app
    // routing, where a catch-all would answer 200.
    if (pathname.startsWith("/.well-known/agent-skills/")) {
      return Response.json({ error: "Not Found", path: pathname }, { status: 404, headers: CORS });
    }
    return null;
  }

  async function discovery(url: URL): Promise<Response | null> {
    const catalog = await agentCatalog(url);
    if (catalog) return catalog;
    switch (url.pathname) {
      case "/llms.txt": {
        const routes = await cfg.routeList();
        // sections, descriptions, and Optional come from each route's `llms` export
        const links = await collectLlmsLinks(url.origin, routes, cfg.resolve);
        return text(llmsTxt(url.origin, routes, agent, docConfig.site, links), "text/markdown; charset=utf-8");
      }
      case "/robots.txt":
        return text(robotsTxt(url.origin, { catalogs: catalogOrigin(url) !== null }), "text/plain; charset=utf-8");
      case "/sitemap.xml":
        return text(
          sitemapXml(
            url.origin,
            await collectSitemapPages(await cfg.routeList(), cfg.resolve, {
              i18n: !!cfg.i18n,
              staticPaths: cfg.staticBuild === true,
            }),
            cfg.i18n,
          ),
          "application/xml; charset=utf-8",
        );
      case "/.well-known/api-catalog":
        // RFC 9727 §2: a HEAD here SHALL carry a Link with rel="api-catalog". The
        // gate answers HEAD with this GET's headers, so both carry it.
        return text(JSON.stringify(apiCatalog(url.origin, agent)), API_CATALOG_CONTENT_TYPE, {
          headers: { link: `</.well-known/api-catalog>; rel="api-catalog"` },
        });
      case SERVER_CARD_PATH:
        return agent.mcp
          ? text(
              JSON.stringify(
                mcpServerCard(url.origin, {
                  site: docConfig.site,
                  agent,
                  icons: docConfig.icons,
                  basePath: docConfig.basePath,
                }),
              ),
              MCP_SERVER_CARD_TYPE,
              { headers: { ...SERVER_CARD_CORS, "cache-control": "public, max-age=3600" } },
            )
          : null;
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
        // ambient `db` is the SAME resource the UI uses, and — via cfg.identity —
        // the same principal: requiresPrincipal actions and per-call connection
        // auth are live on this surface. ctx carries identity only — not resources.
        const identity = cfg.identity ? await cfg.identity(request) : undefined;
        return mcpHandler(
          request,
          { request, ...identity },
          mcpServerIdentity(url.origin, { site: docConfig.site, agent }),
        );
      }
      // The REST projection of the same actions: POST /api/<id> dispatches through
      // the same invokeAction with the same principal as /mcp. Only a registered
      // action's canonical path is claimed — any other /api/* falls through to the app.
      // /openapi.json is the API's own description, so it is gated on agent.api (not
      // agent.discovery) and answered here; the discovery gate below never sees it.
      if (agent.api) {
        if (url.pathname === "/openapi.json" && (request.method === "GET" || request.method === "HEAD")) {
          const doc = Response.json(openApiDocument(url.origin, docConfig.site), {
            // the same type the Link header + api-catalog advertise
            headers: { "content-type": OPENAPI_MEDIA_TYPE, "access-control-allow-origin": "*" },
          });
          // HEAD: the same status + headers, no body.
          return request.method === "HEAD" ? new Response(null, { status: doc.status, headers: doc.headers }) : doc;
        }
        const actionId = apiActionId(url.pathname);
        if (actionId) {
          const identity = cfg.identity ? await cfg.identity(request) : undefined;
          return apiHandler(request, actionId, { request, ...identity });
        }
      }
      // The server card is read cross-origin by browser-based MCP clients; its
      // If-None-Match revalidation is a non-safelisted header → a CORS preflight.
      if (request.method === "OPTIONS" && agent.discovery && agent.mcp && url.pathname === SERVER_CARD_PATH) {
        return new Response(null, { status: 204, headers: SERVER_CARD_CORS });
      }
      // GET and HEAD (Agent Skills Discovery RFC v0.2.0 requires both): a HEAD
      // gets the same status and headers, no body.
      if ((request.method === "GET" || request.method === "HEAD") && agent.discovery) {
        const d = await discovery(url);
        if (d) return request.method === "HEAD" ? new Response(null, { status: d.status, headers: d.headers }) : d;
      }

      // --- durable agent surface (chat + channels) -------------------------
      // The running agent from the agent/ directory: POST <chat.path> for a turn,
      // /channels/* webhooks. Its tools are the SAME defineActions already on /mcp
      // above. Null → not an agent route, fall through.
      if (agent.runtime.enabled && cfg.agentSurface) {
        const a = await cfg.agentSurface(request, url);
        if (a) return a;
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
      // --- generated web manifest (only beside June's generated icons) ------
      if (request.method === "GET" && docConfig.icons?.generated && url.pathname === "/manifest.webmanifest") {
        return text(webManifest(docConfig), "application/manifest+json", {
          headers: { "cache-control": "public, max-age=86400" },
        });
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
        // Publish the resolved locale onto the request scope so an opt-in i18n
        // layer's ambient `t` can read it (the core pipeline never imports i18n).
        if (locale) setRequestLocale(locale);
      }

      // --- routes ----------------------------------------------------------
      const { target, pathname, speculative } = negotiate(url, request, routeBase);
      const resolved = await resolveRoute(pathname);
      if (!resolved) return notFoundResponse(target, pathname, locale, request);

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
      routePathOf.set(ctx, pathname);

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
      const services = cfg.services ? await cfg.services() : undefined;
      return runInScope({ resources, services }, () => handleRequest(request));
    },
  };
}
