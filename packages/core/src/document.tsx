// The shared HTML document shell — ONE implementation drives both the Bun/Node
// dev+prod server and the generated Workers entry, so `june build` output
// renders byte-equivalent heads to `june dev`.
import React from "react";

import type { Metadata } from "./route";

// The serializable slice of app config the document needs. The server feeds it
// from AppConfig; the generated worker inlines it as literals at build time.
export type DocumentConfig = {
  // `lang` is the document-language FLOOR: a single-locale app sets it (default
  // "en") without any i18n machinery. When `i18n` is configured the resolved
  // per-request locale (ctx.locale) overrides it on `<html lang>`.
  site: { name?: string; titleTemplate?: string; description?: string; icon?: string; lang?: string };
  speculationRules: string | null;
  speculationDelivery: "inline" | "header";
  viewTransitions: boolean | "instant" | number;
  // Opt-in client router (config.clientRouter). When true the page is wrapped in
  // <div data-june-root> — the region the router swaps on soft navigation — and
  // that element's presence is the runtime signal the islands bundle reads to
  // start the router. Absent → classic MPA navigation, zero added JS.
  clientRouter?: boolean;
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
};

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
}: {
  children: React.ReactNode;
  metadata?: Metadata;
  config: DocumentConfig;
  // The resolved document language + writing direction for this request. The host
  // passes ctx.locale (or the site.lang floor); absent → "en". `dir` is rendered
  // only when "rtl", so LTR pages stay byte-identical to a single-locale app.
  lang?: string;
  dir?: "ltr" | "rtl";
}) {
  const title = documentTitle(metadata, config.site);
  const description = metadata?.description ?? config.site.description;
  const og = metadata?.openGraph;
  return (
    <html lang={lang ?? config.site.lang ?? "en"} dir={dir === "rtl" ? "rtl" : undefined}>
      <head>
        {/* charset IN the document (must be in the first 1024 bytes): prerendered
            pages are served by asset layers whose content-type may lack the
            charset param — without this, UTF-8 text mojibakes as windows-1252. */}
        <meta charSet="utf-8" />
        {/* site.icon overrides; otherwise the framework's generated letter
            favicon answers /favicon.svg, so no June app 404s its icon. */}
        <link
          rel="icon"
          href={config.site.icon ?? "/favicon.svg"}
          type={(config.site.icon ?? "/favicon.svg").endsWith(".svg") ? "image/svg+xml" : undefined}
        />
        <title>{title}</title>
        {description ? <meta name="description" content={description} /> : null}
        {metadata?.canonical ? <link rel="canonical" href={metadata.canonical} /> : null}
        {metadata?.robots ? <meta name="robots" content={metadata.robots} /> : null}
        {og ? <meta property="og:title" content={og.title ?? title} /> : null}
        {og?.description ?? description ? (
          <meta property="og:description" content={og?.description ?? description} />
        ) : null}
        {og?.image ? <meta property="og:image" content={og.image} /> : null}
        {og ? <meta property="og:type" content={og.type ?? "website"} /> : null}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {config.speculationRules && config.speculationDelivery === "inline" ? (
          <script
            type="speculationrules"
            dangerouslySetInnerHTML={{ __html: config.speculationRules }}
          />
        ) : null}
        {config.speculationRules ? (
          <script dangerouslySetInnerHTML={{ __html: PREFETCH_FALLBACK }} />
        ) : null}
        <style>{`${viewTransitionCss(config.viewTransitions)}
          body {
            margin: 0;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #fbfbf8;
            color: #1d1d1f;
          }

          main {
            width: min(720px, calc(100vw - 32px));
            margin: 72px auto;
          }

          code {
            background: #ecebe4;
            border-radius: 4px;
            padding: 2px 5px;
          }
        `}</style>
        {/* The app's global.css — auto-linked, AFTER the inline base styles so it
            (and a Tailwind reset) wins. Absent → no stylesheet. */}
        {config.styles ? <link rel="stylesheet" href={config.styles} /> : null}
        {/* Collected CSS Modules — after global so component-scoped rules win. */}
        {config.moduleStyles ? <link rel="stylesheet" href={config.moduleStyles} /> : null}
      </head>
      <body>
        {/* clientRouter on → wrap the page in the swap region. Its presence is
            also the router's activation signal (the islands bundle starts the
            router iff [data-june-root] exists). Off → bytes are unchanged. */}
        {config.clientRouter ? <div data-june-root>{children}</div> : children}
        {/* type="module" defers automatically: the island runtime runs after the
            markup is parsed, so markers exist when it scans for them. */}
        {config.clientScript ? <script type="module" src={config.clientScript} /> : null}
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
