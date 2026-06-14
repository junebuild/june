// The shared HTML document shell — ONE implementation drives both the Bun/Node
// dev+prod server and the generated Workers entry, so `june build` output
// renders byte-equivalent heads to `june dev`.
import React from "react";

import type { Metadata } from "./route";

// The serializable slice of app config the document needs. The server feeds it
// from AppConfig; the generated worker inlines it as literals at build time.
export type DocumentConfig = {
  site: { name?: string; titleTemplate?: string; description?: string; icon?: string };
  speculationRules: string | null;
  speculationDelivery: "inline" | "header";
  viewTransitions: boolean;
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
// (and pair with prerender: activation + smooth transition = SPA feel, no
// SPA). prefers-reduced-motion users get instant cuts — accessibility first.
export const VIEW_TRANSITION_CSS = `
          @view-transition { navigation: auto; }
          @media (prefers-reduced-motion: reduce) {
            ::view-transition-group(*),
            ::view-transition-old(*),
            ::view-transition-new(*) { animation: none !important; }
          }`;

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
}: {
  children: React.ReactNode;
  metadata?: Metadata;
  config: DocumentConfig;
}) {
  const title = documentTitle(metadata, config.site);
  const description = metadata?.description ?? config.site.description;
  const og = metadata?.openGraph;
  return (
    <html lang="en">
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
        <style>{`${config.viewTransitions ? VIEW_TRANSITION_CSS : ""}
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
        {children}
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
