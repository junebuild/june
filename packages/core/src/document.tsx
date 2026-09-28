// The shared HTML document shell — ONE implementation drives both the Bun/Node
// dev+prod server and the generated Workers entry, so `june build` output
// renders byte-equivalent heads to `june dev`.
import React from "react";

import type { Metadata } from "./route";
import type { RouterMode, SiteConfig } from "./config";

// The serializable slice of app config the document needs. The server feeds it
// from AppConfig; the generated worker inlines it as literals at build time.
export type DocumentConfig = {
  // `lang` is the document-language FLOOR: a single-locale app sets it (default
  // "en") without any i18n machinery. When `i18n` is configured the resolved
  // per-request locale (ctx.locale) overrides it on `<html lang>`.
  site: SiteConfig;
  speculationRules: string | null;
  speculationDelivery: "inline" | "header";
  viewTransitions: boolean | "instant" | number;
  // June's built-in zero-config defaults: the baseline reset (BASE_RESET_CSS) AND the starter look
  // (STARTER_CONTENT_CSS — page background, a centered 720px column, inline-code chips). The reset is
  // :where()-wrapped (zero-specificity); the starter look is full-specificity AND unlayered, so it
  // would override an app's own CSS (Tailwind utilities/typography included). Both default ON and are
  // dropped together when `false` — set it when your CSS already ships a reset and owns the look (e.g.
  // Tailwind Preflight + your own styles). Maps from JuneConfig.cssReset (auto-off when Tailwind is
  // detected in app/global.css).
  cssReset?: boolean;
  // Opt-in client router (resolved from config.clientRouter). When not "off" the
  // page is wrapped in <div data-june-root> — the region the router swaps on soft
  // navigation — and that element's presence is the runtime signal the islands
  // bundle reads to start the router. "off"/absent → classic MPA navigation, zero
  // added JS. The applier ("morph" default, "flight" opt-in) rides on the same
  // element as data-june-router (omitted for morph → byte-identical to before).
  clientRouter?: RouterMode;
  // URL of the client islands runtime bundle. Set by the host (dev serves it,
  // build freezes its hashed path) when the app has islands; the document then
  // loads it as a deferred module so `"use client"` islands hydrate. Absent /
  // null → the page ships zero client JS.
  clientScript?: string | null;
  // URL of the global stylesheet. Set by the host (dev serves it, build emits it
  // as an asset) when `app/global.css` exists — auto-linked, no import. Absent /
  // null → no stylesheet. CSS is a HUMAN-surface concern; agent projections
  // (.md/.json/mcp) never carry it.
  styles?: string | null;
  // URL of the collected CSS-Modules stylesheet (app/**/*.module.css), when any
  // exist. Linked after `styles` so component-scoped rules win over the global
  // sheet. Same dev-stable / build-hashed split as `styles`.
  moduleStyles?: string | null;
  // WebMCP tool manifest (name/description/inputSchema) — the SAME actions the
  // server exposes at /mcp. When present, the document injects a tiny script
  // that registers each via navigator.modelContext.registerTool() so an
  // in-browser agent can call them (each tool's execute proxies to /mcp).
  webmcpTools?: Array<{ name: string; description?: string; inputSchema?: unknown }> | null;
  // Public-path prefix the whole site is served under (JuneConfig.basePath), e.g.
  // "/openab/docs" for a GitHub Pages project subpath. When set, the framework asset
  // URLs below (favicon/styles/moduleStyles/clientScript) — which are root-absolute
  // ("/_june/…") — are prefixed so they resolve under the subpath. Empty/absent =
  // root deploy (unchanged). Only the static() target sets it.
  basePath?: string;
  // "https://<deploy.domain>" when the config names one: the public origin for
  // pages whose request can't supply it (prerendered pages render against a
  // placeholder host). Kept apart from site.url so a locale's own domain can
  // still win over it — see publicOrigin().
  deployOrigin?: string;
  // The icon links, filled by the host from public/ (see favicon.ts resolveIcons):
  //   primary     the app's own main icon (public/favicon.svg, icon.svg, …) —
  //               linked in place of June's letter /favicon.svg; site.icon wins
  //   png         a 32×32 PNG (Google Search and some browsers skip SVG)
  //   appleTouch  the iOS home-screen icon
  //   manifest    the web app manifest (Android "Add to Home Screen")
  //   generated   true when the set is June's own (the pipeline then serves the
  //               generated /manifest.webmanifest)
  // June's generated set when the app has no icon of its own. Absent → only the
  // favicon link.
  icons?: { primary?: string; png?: string; appleTouch?: string; manifest?: string; generated?: boolean } | null;
};

// June's built-in baseline CSS reset — a minimal, Tailwind-Preflight-aligned normalize, NOT a layout
// opinion. Every rule is wrapped in :where() so it carries ZERO specificity: present as a safe baseline
// for apps with no reset, yet trivially overridden by any stylesheet (so it never fights an app's own
// styles, Tailwind Preflight included). Deliberately omits `cursor: pointer` on buttons to match
// Tailwind v4 / browser-native behavior. Injected unless `cssReset: false`.
export const BASE_RESET_CSS = `:where(*,::before,::after,::backdrop){box-sizing:border-box}
:where(html){-webkit-text-size-adjust:100%}
:where(body){margin:0}
:where(img,picture,video,canvas,svg){display:block;max-width:100%}
:where(button,input,select,textarea){font:inherit}
:where(button){color:inherit;background:none;border:0}`;

// June's zero-config "starter look": opinionated defaults — a page background, a centered 720px reading
// column, and inline-code chips — that make an app shipping NO CSS of its own look decent immediately.
// Unlike BASE_RESET_CSS these are full-specificity LAYOUT/LOOK opinions, not a :where() reset, so they
// would fight an app that brings its own styling. CSS cascade layers don't save us here: these are
// unlayered, and unlayered normal declarations outrank EVERY @layer (Tailwind utilities and the
// typography plugin included) regardless of specificity. So they're injected together with the reset
// and, like it, DEFERRED when the app brings its own system (cssReset === false — which auto-derives
// from Tailwind detection in the host). Then Tailwind Preflight + the app's CSS own the look entirely.
// The starter look's page background — also its default theme-color.
export const STARTER_BACKGROUND = "#fbfbf8";
export const STARTER_CONTENT_CSS = `body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:${STARTER_BACKGROUND};color:#1d1d1f}
main{width:min(720px,calc(100vw - 32px));margin:72px auto}
code{background:#ecebe4;border-radius:4px;padding:2px 5px}`;

// Cross-document View Transitions: same-origin MPA navigations cross-fade
// (and pair with prerender: activation + smooth transition = SPA feel, no SPA).
//
// The browser-default cross-fade runs ~250ms. On a PRERENDERED navigation the
// page is already there, so the fade isn't masking a load — it's pure tax played
// AFTER the new page is ready, with a hazy double-exposure mid-cross-fade that
// reads as lag. We override only animation-duration on the UA cross-fade
// (author > UA, so the browser's own keyframes still drive it — the most robust
// baseline) and default to a snappy 120ms: motion as polish, not manufactured
// delay. prefers-reduced-motion always collapses to an instant cut.
const VIEW_TRANSITION_DEFAULT_MS = 120;

// Build the View Transition CSS for the resolved setting:
//   true      → cross-fade at the default duration
//   number    → cross-fade at that many ms (0 = instant cut)
//   "instant" → cross-document activation with no animation (instant cut)
//   false     → "" (no @view-transition rule; the caller drops it entirely)
export function viewTransitionCss(opt: boolean | "instant" | number): string {
  if (opt === false) return "";
  const ms =
    opt === true ? VIEW_TRANSITION_DEFAULT_MS : opt === "instant" ? 0 : Math.max(0, opt);
  return `
          @view-transition { navigation: auto; }
          ::view-transition-group(root),
          ::view-transition-old(root),
          ::view-transition-new(root) { animation-duration: ${ms}ms; }
          @media (prefers-reduced-motion: reduce) {
            ::view-transition-group(*),
            ::view-transition-old(*),
            ::view-transition-new(*) { animation: none !important; }
          }`;
}

export const PREFETCH_FALLBACK = `(function(){if(HTMLScriptElement.supports&&HTMLScriptElement.supports('speculationrules'))return;var seen=new Set();document.addEventListener('pointerover',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var u=new URL(a.href,location.href);if(u.origin!==location.origin||seen.has(u.pathname)||u.pathname===location.pathname)return;if(/\.(md|json)$/.test(u.pathname)||u.pathname==='/mcp')return;seen.add(u.pathname);var l=document.createElement('link');l.rel='prefetch';l.href=u.pathname+u.search;document.head.appendChild(l);},{passive:true});})();`;

// WebMCP bridge: register each declared action via navigator.modelContext so an
// in-browser agent can call it; execute() proxies to /mcp (the same dispatch the
// server MCP endpoint uses). No-op when the browser lacks the API. An
// AbortController lets a future SPA navigation unregister. Reads its tool list
// from the adjacent <script id="june-webmcp"> JSON.
export const WEBMCP_SCRIPT = `(function(){var mc=navigator.modelContext;if(!mc||!mc.registerTool)return;var el=document.getElementById('june-webmcp');if(!el)return;var tools;try{tools=JSON.parse(el.textContent)}catch(e){return}var ac=new AbortController();tools.forEach(function(t){mc.registerTool({name:t.name,description:t.description,inputSchema:t.inputSchema,execute:function(args){return fetch('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:t.name,arguments:args}})}).then(function(r){return r.json()}).then(function(j){return j.result})}},{signal:ac.signal})})})();`;

// The host `june build` renders prerendered pages against. It is a placeholder,
// so the document never derives a public URL from it.
export const PRERENDER_ORIGIN = "https://prerender.june";

// The public origin for absolute social URLs, first match wins:
//   1. the request's origin when it is an i18n locale's OWN domain (example.fr
//      is that locale's public origin, whatever site.url says);
//   2. site.url;
//   3. the deploy domain;
//   4. the request's origin — never the prerender placeholder.
// undefined → the document emits no og:url / canonical / JSON-LD and drops a
// root-relative og:image, rather than emitting a wrong or unusable URL.
function publicOrigin(config: DocumentConfig, pageUrl?: string, onLocaleDomain?: boolean): string | undefined {
  const requested = pageUrl ? new URL(pageUrl).origin : undefined;
  const live = requested && requested !== PRERENDER_ORIGIN ? requested : undefined;
  if (onLocaleDomain && live) return live;
  if (config.site.url) return config.site.url.replace(/\/+$/, "");
  return config.deployOrigin ?? live;
}

// The canonical URL of a page's HTML form, for surfaces rendered outside the
// Document (the markdown projection's frontmatter). Same rules as the <link
// rel="canonical"> the Document emits: metadata.canonical wins, else the public
// origin + the page path; noindex pages and an unknown origin get none.
export function pageCanonical(
  config: DocumentConfig,
  metadata: Metadata | undefined,
  pageUrl: string | undefined,
  pagePath: string | undefined,
  onLocaleDomain?: boolean,
): string | undefined {
  const origin = publicOrigin(config, pageUrl, onLocaleDomain);
  const base = (u: string) => (config.basePath && u.startsWith("/") && !u.startsWith("//") ? config.basePath + u : u);
  const c = metadata?.canonical;
  if (c) return c.startsWith("/") && !c.startsWith("//") ? (origin ? origin + base(c) : undefined) : c;
  if (!origin || !pagePath || metadata?.robots?.includes("noindex")) return undefined;
  return origin + base(pagePath);
}

// theme-color: the app's, else the starter background — but only when June's
// starter look is the WHOLE look (no global.css or CSS Modules on top); any
// other page background is unknown here, and a guessed toolbar colour is worse
// than none. Shared with the generated web manifest.
export function resolveThemeColor(config: DocumentConfig): SiteConfig["themeColor"] {
  const ownsLook = config.cssReset !== false && !config.styles && !config.moduleStyles;
  return config.site.themeColor ?? (ownsLook ? STARTER_BACKGROUND : undefined);
}

// The favicon link's type attribute, from its extension (unknown → none).
function iconType(href: string): string | undefined {
  const ext = href.split(/[?#]/)[0]!.split(".").pop()?.toLowerCase();
  return ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "ico" ? "image/x-icon" : undefined;
}

// og:locale wants ll_CC ("en_US"); <html lang> is BCP 47 ("en-US").
function ogLocale(lang: string): string {
  return lang.replace("-", "_");
}

// JSON-LD is raw script text: escape "<" so a description can't close the tag.
function websiteJsonLd(site: SiteConfig, url: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: site.name,
    url,
    description: site.description,
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function documentTitle(
  meta: Metadata | undefined,
  site: DocumentConfig["site"],
): string {
  if (meta?.title) {
    // The site name as a page title means "this IS the site" (homepages) —
    // don't template it into "Site · Site".
    if (meta.title === site.name) return meta.title;
    return site.titleTemplate ? site.titleTemplate.replace("%s", meta.title) : meta.title;
  }
  return site.name ?? "June app";
}

export function Document({
  children,
  metadata,
  config,
  lang,
  dir,
  alternates,
  shellKey,
  pageUrl,
  isHome,
  onLocaleDomain,
  markdownHref,
}: {
  children: React.ReactNode;
  metadata?: Metadata;
  config: DocumentConfig;
  // The resolved document language + writing direction for this request. The host
  // passes ctx.locale (or the site.lang floor); absent → "en". `dir` is rendered
  // only when "rtl", so LTR pages stay byte-identical to a single-locale app.
  lang?: string;
  dir?: "ltr" | "rtl";
  // rel="alternate" hreflang links for this page's locale variants (incl.
  // x-default), built by the pipeline from the i18n table. Absent when i18n is
  // off, so single-locale pages emit no hreflang.
  alternates?: Array<{ hreflang: string; href: string }>;
  // The mounted shell's identity (a segment-boundary route's key), stamped on
  // [data-june-root] as data-june-shell so the client router can tell whether a
  // soft-nav fragment belongs to this shell. Absent on non-boundary routes.
  shellKey?: string | null;
  // The request URL (href). Yields og:url + canonical; its origin is the public
  // one on a locale's own domain, or when nothing else names one. Absent → no
  // URL-derived tags.
  pageUrl?: string;
  // The matched route is the site's home ("/", whatever the locale prefix or
  // /index alias in the URL) → the WebSite JSON-LD goes on this page.
  isHome?: boolean;
  // The request host is an i18n locale's own domain (see publicOrigin).
  onLocaleDomain?: boolean;
  // Root-relative URL of this page's markdown twin (e.g. /docs/intro.md,
  // /index.md for home), advertised as rel="alternate" type="text/markdown" so an
  // agent reading the HTML finds the clean projection. The host passes it only
  // when the route's md projection is live; absent → no link.
  markdownHref?: string;
}) {
  const title = documentTitle(metadata, config.site);
  const description = metadata?.description ?? config.site.description;
  const og = metadata?.openGraph;
  // basePath: prefix the framework's root-absolute asset URLs so they resolve under
  // a deploy subpath (e.g. GitHub Pages "/openab/docs"). Only single-leading-slash
  // URLs are rewritten (leaves "//cdn", "https://…", and empty basePath untouched).
  const withBase = (u?: string | null): string | undefined =>
    u && config.basePath && u.startsWith("/") && !u.startsWith("//") ? config.basePath + u : u ?? undefined;
  // Social tags are on for every page, so a link shared from any June app unfurls
  // as a card; metadata.openGraph / metadata.twitter only override the values.
  const origin = publicOrigin(config, pageUrl, onLocaleDomain);
  // Root-relative → absolute against the public origin; with no origin it is
  // dropped (unfurlers can't resolve a relative og:image). Absolute URLs pass.
  const absolute = (u?: string): string | undefined => {
    if (!u || !u.startsWith("/") || u.startsWith("//")) return u;
    return origin ? origin + withBase(u) : undefined;
  };
  const canonical = pageCanonical(config, metadata, pageUrl, pageUrl && new URL(pageUrl).pathname, onLocaleDomain);
  const favicon = config.site.icon ?? config.icons?.primary ?? "/favicon.svg";
  const themeColor = resolveThemeColor(config);
  const docLang = lang ?? config.site.lang ?? "en";
  const ogTitle = og?.title ?? title;
  const ogDescription = og?.description ?? description;
  const ogImage = absolute(og?.image);
  return (
    <html lang={docLang} dir={dir === "rtl" ? "rtl" : undefined}>
      <head>
        {/* charset IN the document (must be in the first 1024 bytes): prerendered
            pages are served by asset layers whose content-type may lack the
            charset param — without this, UTF-8 text mojibakes as windows-1252. */}
        <meta charSet="utf-8" />
        {/* site.icon overrides, then the app's own icon in public/; otherwise the
            framework's generated letter favicon answers /favicon.svg, so no June
            app 404s its icon. */}
        <link rel="icon" href={withBase(favicon)} type={iconType(favicon)} />
        {config.icons?.png && config.icons.png !== favicon ? (
          <link rel="icon" href={withBase(config.icons.png)} type="image/png" sizes="32x32" />
        ) : null}
        {config.icons?.appleTouch ? <link rel="apple-touch-icon" href={withBase(config.icons.appleTouch)} /> : null}
        {config.icons?.manifest ? <link rel="manifest" href={withBase(config.icons.manifest)} /> : null}
        <title>{title}</title>
        {description ? <meta name="description" content={description} /> : null}
        {canonical ? <link rel="canonical" href={canonical} /> : null}
        {markdownHref ? <link rel="alternate" type="text/markdown" href={withBase(markdownHref)} /> : null}
        {alternates?.map((a) => (
          <link key={a.hreflang} rel="alternate" hrefLang={a.hreflang} href={a.href} />
        ))}
        {metadata?.robots ? <meta name="robots" content={metadata.robots} /> : null}
        <meta property="og:title" content={ogTitle} />
        {ogDescription ? <meta property="og:description" content={ogDescription} /> : null}
        <meta property="og:type" content={og?.type ?? "website"} />
        {canonical ? <meta property="og:url" content={canonical} /> : null}
        {config.site.name ? <meta property="og:site_name" content={config.site.name} /> : null}
        <meta property="og:locale" content={ogLocale(docLang)} />
        {ogImage ? <meta property="og:image" content={ogImage} /> : null}
        {ogImage && og?.imageWidth ? <meta property="og:image:width" content={String(og.imageWidth)} /> : null}
        {ogImage && og?.imageHeight ? <meta property="og:image:height" content={String(og.imageHeight)} /> : null}
        {ogImage ? <meta property="og:image:alt" content={og?.imageAlt ?? ogTitle} /> : null}
        {/* X falls back to og:title/description/image; it only needs the card type. */}
        <meta
          name="twitter:card"
          content={metadata?.twitter?.card ?? (ogImage ? "summary_large_image" : "summary")}
        />
        {config.site.twitter ? <meta name="twitter:site" content={config.site.twitter} /> : null}
        {metadata?.twitter?.creator ? <meta name="twitter:creator" content={metadata.twitter.creator} /> : null}
        {/* The homepage names the site for search engines (schema.org WebSite). */}
        {isHome && origin ? (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: websiteJsonLd(config.site, origin + (withBase("/") ?? "/")) }}
          />
        ) : null}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {typeof themeColor === "string" ? <meta name="theme-color" content={themeColor} /> : null}
        {themeColor && typeof themeColor === "object" ? (
          <>
            <meta name="theme-color" media="(prefers-color-scheme: light)" content={themeColor.light} />
            <meta name="theme-color" media="(prefers-color-scheme: dark)" content={themeColor.dark} />
          </>
        ) : null}
        {config.speculationRules && config.speculationDelivery === "inline" ? (
          <script
            type="speculationrules"
            dangerouslySetInnerHTML={{ __html: config.speculationRules }}
          />
        ) : null}
        {config.speculationRules ? (
          <script dangerouslySetInnerHTML={{ __html: PREFETCH_FALLBACK }} />
        ) : null}
        {/* June's zero-config reset + starter look. Both are deferred when the app brings its own
            styling system (cssReset === false, auto-set when Tailwind is detected) so they never fight
            it — see BASE_RESET_CSS / STARTER_CONTENT_CSS. View-transition CSS is orthogonal, always on. */}
        <style>{`${viewTransitionCss(config.viewTransitions)}
${config.cssReset === false ? "" : BASE_RESET_CSS + "\n" + STARTER_CONTENT_CSS}`}</style>
        {/* The app's global.css — auto-linked, AFTER the inline base styles so it
            (and a Tailwind reset) wins. Absent → no stylesheet. */}
        {config.styles ? <link rel="stylesheet" href={withBase(config.styles)} /> : null}
        {/* Collected CSS Modules — after global so component-scoped rules win. */}
        {config.moduleStyles ? <link rel="stylesheet" href={withBase(config.moduleStyles)} /> : null}
      </head>
      <body>
        {/* clientRouter not "off" → wrap the page in the swap region. Its
            presence is the router's activation signal (the islands bundle starts
            the router iff [data-june-root] exists); data-june-router names the
            applier. "off" → bytes unchanged; "morph" → router attr omitted, so
            byte-identical to the previous boolean output. */}
        {config.clientRouter && config.clientRouter !== "off" ? (
          <div
            data-june-root
            data-june-router={config.clientRouter === "flight" ? "flight" : undefined}
            data-june-shell={shellKey ?? undefined}
          >
            {children}
          </div>
        ) : (
          children
        )}
        {/* type="module" defers automatically: the island runtime runs after the
            markup is parsed, so markers exist when it scans for them. */}
        {config.clientScript ? <script type="module" src={withBase(config.clientScript)} /> : null}
        {config.webmcpTools && config.webmcpTools.length ? (
          <>
            <script
              type="application/json"
              id="june-webmcp"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(config.webmcpTools) }}
            />
            <script dangerouslySetInnerHTML={{ __html: WEBMCP_SCRIPT }} />
          </>
        ) : null}
      </body>
    </html>
  );
}
