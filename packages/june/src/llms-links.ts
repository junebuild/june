// /llms.txt links, collected from the routes themselves. Each route may export
// `llms` (see LlmsEntry in @junejs/core/route): a static route defaults to one link
// under "Pages" built from its static metadata; a dynamic route — a [param]
// template an agent can't fetch — lists each real page it serves, or is skipped.
// Links point at the markdown projection (<path>.md) unless the route turned md off,
// so an agent reads the page rather than its HTML (llmstxt.org's recommendation).
import type { LlmsLink } from "@junejs/core/discovery";
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
