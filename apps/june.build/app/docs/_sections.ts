// Shared doc grouping for the sidebar and the /docs index: docs without a
// `section` come first, then each named section; within each, docs sort by
// their `order` frontmatter.
import { DOCS, type ContentEntry } from "../_content";

export type DocSection = { title: string; docs: ContentEntry[] };

const orderOf = (d: ContentEntry) => {
  const n = Number(d.data.order);
  return Number.isFinite(n) ? n : 999;
};

export function docSections(): DocSection[] {
  const ordered = [...DOCS].sort(
    (a, b) => orderOf(a) - orderOf(b) || a.slug.localeCompare(b.slug),
  );
  const titles = [...new Set(ordered.map((d) => String(d.data.section ?? "")))].sort(
    (a, b) => (a === "") === (b === "") ? 0 : a === "" ? -1 : 1,
  );
  return titles.map((title) => ({
    title,
    docs: ordered.filter((d) => String(d.data.section ?? "") === title),
  }));
}
