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
  run(input: { query: string }) {
    const q = input.query.toLowerCase();
    const pages = PAGES.filter((p) => (p.title + p.summary + p.md).toLowerCase().includes(q)).map(
      (p) => ({ slug: p.slug, title: p.title, summary: p.summary }),
    );
    const posts = POSTS.filter((p) => (p.data.title + " " + p.original).toLowerCase().includes(q)).map(
      (p) => ({ slug: `blog/${p.slug}`, title: String(p.data.title), summary: String(p.data.description ?? "") }),
    );
    const docs = DOCS.filter((d) => (d.data.title + " " + d.original).toLowerCase().includes(q)).map(
      (d) => ({ slug: `docs/${d.slug}`, title: String(d.data.title), summary: String(d.data.description ?? "") }),
    );
    return [...pages, ...posts, ...docs];
  },
});

export const get_page = defineAction({
  id: "get_page",
  description:
    "Fetch one june.build page as clean markdown. Slugs: index, why, benchmarks, blog/<slug>, docs/<slug>.",
  input: {
    type: "object",
    properties: { slug: { type: "string", description: "Page slug (e.g. why)" } },
    required: ["slug"],
  },
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
