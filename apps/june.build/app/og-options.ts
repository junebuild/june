// Which card a slug gets: /og/<slug>.png looks the slug up across posts, docs,
// and pages (app/og/[slug]/route.ts). Its own module so the mapping is testable
// without rasterizing a PNG.
import { DOCS, POSTS } from "./_content";
import { PAGES } from "./content";
import type { OgOptions } from "./og-card";

export function ogOptions(slug: string): OgOptions {
  const post = POSTS.find((p) => p.slug === slug);
  if (post) return { title: String(post.data.title), path: `/blog/${slug}`, kind: "blog", date: String(post.data.date ?? "") };
  const doc = DOCS.find((d) => d.slug === slug);
  if (doc) return { title: String(doc.data.title), path: `/docs/${slug}`, kind: "docs" };
  const page = slug === "index" ? undefined : PAGES.find((p) => p.slug === slug);
  if (page) return { title: page.title, path: `/${slug}` };
  // the home card (and any unknown slug): the hero's line — the wordmark already says "June"
  return { title: "Build agents into real apps.", path: "/" };
}
