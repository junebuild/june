// The site's agent tools — INTENT tools per docs/mcp-dx.md (high-signal
// returns, never raw dumps). "Ask an agent about June via our MCP."
import { defineAction } from "@junejs/core/agent";

import { PAGES, bySlug } from "./content";
import { POSTS, post, DOCS, doc } from "./_content";

export const search_site = defineAction({
  id: "search_site",
  description:
    "Search june.build's pages by keyword. Returns matching pages as concise cards (slug, title, summary) — fetch full content with get_page.",
  input: {
    type: "object",
    properties: { query: { type: "string", description: "Keyword or phrase" } },
    required: ["query"],
  },
  // Reads this site's own pages, nothing else — clients may auto-approve it.
  annotations: { title: "Search june.build", readOnlyHint: true, openWorldHint: false },
  run(input: { query: string }) {
    // Terms are runs of letters/digits in any script, so "slack?" or "cold-start"
    // match like "slack" and "cold start". Every term of 2+ chars counts; a title hit
    // outweighs a body hit. Ranked, capped — a card list, not a dump.
    const terms = input.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
    if (terms.length === 0) return [];
    const score = (title: string, body: string) => {
      const t = title.toLowerCase();
      const b = body.toLowerCase();
      return terms.reduce((s, term) => s + (t.includes(term) ? 3 : 0) + (b.includes(term) ? 1 : 0), 0);
    };
    const cards = [
      ...PAGES.map((p) => ({
        card: { slug: p.slug, title: p.title, summary: p.summary },
        score: score(p.title, p.summary + " " + p.md),
      })),
      ...POSTS.map((p) => ({
        card: { slug: `blog/${p.slug}`, title: String(p.data.title), summary: String(p.data.description ?? "") },
        score: score(String(p.data.title), p.original),
      })),
      ...DOCS.map((d) => ({
        card: { slug: `docs/${d.slug}`, title: String(d.data.title), summary: String(d.data.description ?? "") },
        score: score(String(d.data.title), d.original),
      })),
    ];
    return cards
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((c) => c.card);
  },
});

export const get_page = defineAction({
  id: "get_page",
  description:
    // The page slugs come from PAGES, so a new page is advertised here the moment it exists.
    `Fetch one june.build page as clean markdown. Slugs: ${PAGES.map((p) => p.slug).join(", ")}, blog/<slug>, docs/<slug>.`,
  input: {
    type: "object",
    properties: { slug: { type: "string", description: "Page slug (e.g. why)" } },
    required: ["slug"],
  },
  annotations: { title: "Read a june.build page", readOnlyHint: true, openWorldHint: false },
  run(input: { slug: string }) {
    const page = bySlug(input.slug);
    if (page) return { slug: page.slug, title: page.title, markdown: page.md };
    const entry = post(input.slug.replace(/^blog\//, ""));
    if (entry) return { slug: `blog/${entry.slug}`, title: String(entry.data.title), markdown: entry.original };
    const d = doc(input.slug.replace(/^docs\//, ""));
    if (d) return { slug: `docs/${d.slug}`, title: String(d.data.title), markdown: d.original };
    return {
      error:
        `No page "${input.slug}". Pages: ${PAGES.map((p) => p.slug).join(", ")}; ` +
        `posts: ${POSTS.map((p) => `blog/${p.slug}`).join(", ")}; ` +
        `docs: ${DOCS.map((d) => `docs/${d.slug}`).join(", ")}`,
    };
  },
});
