// june content — the content pipeline: markdown files as content collections,
// dual-audience by construction.
//
//   content/posts/2026-06-10-hello.md
//     ├─ frontmatter  → entry.data (title/date/description/tags…) → metadata
//     ├─ body         → entry.html (rendered) for the view projection
//     └─ THE FILE     → entry.original — served VERBATIM as the .md projection.
//
// The last line is the differentiator: other frameworks' "markdown output" is
// a lossy HTML→md conversion; June's .md projection IS the authored source.
// Agents read exactly what the author wrote (frontmatter included).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

export type ContentEntry = {
  slug: string;
  file: string;
  /** Parsed frontmatter (string values; `tags`-style lists become string[]). */
  data: Record<string, string | string[]>;
  /** The markdown body (frontmatter stripped). */
  body: string;
  /** The authored file, verbatim — the agent-facing .md projection. */
  original: string;
  /** The body rendered to HTML (marked). */
  html: string;
};

// Minimal frontmatter: `key: value` lines between --- fences; `[a, b]` lists
// supported, nested YAML is not — keep frontmatter flat and simple. (A full
// YAML parser is a later, deliberate dependency.)
function parseFrontmatter(raw: string): { data: ContentEntry["data"]; body: string } {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const data: ContentEntry["data"] = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: raw.slice(end + 4).replace(/^\n+/, "") };
}

// mtime-keyed memo: correct under dev edits, free in production.
const memo = new Map<string, { mtime: number; entry: ContentEntry }>();

function loadEntry(file: string, slug: string): ContentEntry {
  const mtime = statSync(file).mtimeMs;
  const hit = memo.get(file);
  if (hit && hit.mtime === mtime) return hit.entry;
  const original = readFileSync(file, "utf8");
  const { data, body } = parseFrontmatter(original);
  const entry: ContentEntry = {
    slug,
    file,
    data,
    body,
    original,
    html: marked.parse(body, { async: false }) as string,
  };
  memo.set(file, { mtime, entry });
  return entry;
}

/** All entries in a content directory, newest-first by `date` (then slug). */
export function collection(dir: string): ContentEntry[] {
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .map((f) => loadEntry(join(dir, f), f.replace(/\.(md|mdx)$/, "")));
  return entries.sort((a, b) => {
    const da = String(a.data.date ?? "");
    const db = String(b.data.date ?? "");
    return db.localeCompare(da) || a.slug.localeCompare(b.slug);
  });
}

/** One entry by slug, or null. */
export function entry(dir: string, slug: string): ContentEntry | null {
  // Guard the slug — it comes from the URL.
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  for (const ext of [".md", ".mdx"]) {
    const file = join(dir, slug + ext);
    try {
      return loadEntry(file, slug);
    } catch {
      /* try next ext */
    }
  }
  return null;
}
