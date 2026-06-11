// The shared HTML document shell — ONE implementation drives both the Bun/Node
// dev+prod server and the generated Workers entry, so `june build` output
// renders byte-equivalent heads to `june dev`.
import React from "react";

import type { Metadata } from "./route";

// The serializable slice of app config the document needs. The server feeds it
// from AppConfig; the generated worker inlines it as literals at build time.
export type DocumentConfig = {
  site: { name?: string; titleTemplate?: string; description?: string };
  speculationRules: string | null;
  speculationDelivery: "inline" | "header";
  viewTransitions: boolean;
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

export const PREFETCH_FALLBACK = `(function(){if(HTMLScriptElement.supports&&HTMLScriptElement.supports('speculationrules'))return;var seen=new Set();document.addEventListener('pointerover',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var u=new URL(a.href,location.href);if(u.origin!==location.origin||seen.has(u.pathname)||u.pathname===location.pathname)return;if(/\.(md|json|agent)$/.test(u.pathname)||u.pathname==='/mcp')return;seen.add(u.pathname);var l=document.createElement('link');l.rel='prefetch';l.href=u.pathname+u.search;document.head.appendChild(l);},{passive:true});})();`;

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
      </head>
      <body>{children}</body>
    </html>
  );
}
