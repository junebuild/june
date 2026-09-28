// /llms.txt links, collected from the routes themselves. Each route may export
// `llms` (see LlmsEntry in @junejs/core/route): a static route defaults to one link
// under "Pages" built from its static metadata; a dynamic route — a [param]
// template an agent can't fetch — lists each real page it serves, or is skipped.
// Links point at the markdown projection (<path>.md) unless the route turned md off,
// so an agent reads the page rather than its HTML (llmstxt.org's recommendation).
import type { LlmsLink, SitemapPage } from "@junejs/core/discovery";
import type { LlmsEntry } from "@junejs/core/route";

import type { RouteResolver } from "./pipeline";

const DEFAULT_SECTION = "Pages";

const mdPath = (path: string) => (path === "/" ? "/index.md" : `${path.replace(/\/+$/, "")}.md`);

export async function collectLlmsLinks(origin: string, routes: string[], resolve: RouteResolver): Promise<LlmsLink[]> {
  const links: LlmsLink[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    // A dynamic template resolves against its own pattern ("/docs/[slug]" matches
    // /docs/:slug), which is all we need: the route definition, not its data.
    const resolved = await resolve(route);
    if (!resolved || !("def" in resolved)) continue; // resource routes have no page to list
    const { def } = resolved;
    if (def.llms === false) continue;

    const dynamic = route.includes("[");
    const declared = typeof def.llms === "function" ? await def.llms() : def.llms;
    const entries: LlmsEntry[] = declared ? (Array.isArray(declared) ? declared : [declared]) : dynamic ? [] : [{}];
    // Static metadata only: a metadata FUNCTION needs loader data we don't run here.
    const meta = typeof def.metadata === "object" ? def.metadata : undefined;

    for (const entry of entries) {
      const path = entry.path ?? (dynamic ? undefined : route);
      if (!path) continue; // a dynamic entry must name its page
      const url = origin + (def.md === false ? path : mdPath(path));
      // dedupe on the FINAL url: "/a" and "/a/" both render /a.md, so they're one page
      if (seen.has(url)) continue;
      seen.add(url);
      const own = path === route; // the route's own page → its metadata describes it
      links.push({
        title: entry.title ?? (own ? meta?.title : undefined) ?? path,
        url,
        description: entry.description ?? (own ? meta?.description : undefined),
        section: entry.section ?? DEFAULT_SECTION,
        optional: entry.optional === true,
      });
    }
  }
  return links;
}

// /sitemap.xml pages, enumerated like /llms.txt. A static route is one page; a
// dynamic route lists its real pages via its `llms` entries (their `lastModified`
// becomes <lastmod>) — the runtime-safe hook /llms.txt already runs. A route
// that names none stays out: a [param] template isn't a URL. Resource routes
// (route.*) are machine endpoints, not pages. `llms = false` keeps a static
// route listed (its URL is known without entries); on a dynamic route it leaves
// no entries, so its pages drop out of the runtime sitemap too.
// `staticPaths` join in only when opts.staticPaths is set — the static() build's
// prerender, the one place the route contract runs them. Even then they're
// skipped under i18n: they arrive locale-prefixed, while the sitemap derives
// each page's locale variants from its canonical path.
export async function collectSitemapPages(
  routes: string[],
  resolve: RouteResolver,
  opts: { i18n?: boolean; staticPaths?: boolean } = {},
): Promise<SitemapPage[]> {
  const pages = new Map<string, SitemapPage>();
  const add = (path: string, lastModified?: string | Date) => {
    const key = path === "/" ? "/" : path.replace(/\/+$/, "");
    const prev = pages.get(key);
    if (!prev) pages.set(key, lastModified ? { path: key, lastModified } : { path: key });
    else if (lastModified && !prev.lastModified) prev.lastModified = lastModified;
  };
  for (const route of routes) {
    const resolved = await resolve(route);
    if (!resolved || !("def" in resolved)) continue;
    const { def } = resolved;
    const dynamic = route.includes("[");
    const declared = def.llms ? (typeof def.llms === "function" ? await def.llms() : def.llms) : undefined;
    const entries: LlmsEntry[] = declared ? (Array.isArray(declared) ? declared : [declared]) : [];
    // A static route is exactly one URL — its own. An entry naming another path
    // (an llms.txt pointer elsewhere) is not a page this route serves.
    if (!dynamic) {
      add(route, entries.find((e) => (e.path ?? route) === route)?.lastModified);
      continue;
    }
    for (const e of entries) if (e.path) add(e.path, e.lastModified);
    if (opts.staticPaths && !opts.i18n && def.staticPaths) {
      const sp = typeof def.staticPaths === "function" ? await def.staticPaths() : def.staticPaths;
      for (const p of sp) add(p);
    }
  }
  return [...pages.values()];
}
