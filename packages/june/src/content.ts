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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  /** The locale this entry was authored in — set for files under a `<locale>/`
   *  subdir, undefined for the flat (default-locale) files. */
  locale?: string;
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

function loadEntry(file: string, slug: string, locale?: string): ContentEntry {
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
    ...(locale ? { locale } : {}),
  };
  memo.set(file, { mtime, entry });
  return entry;
}

const isMd = (f: string) => f.endsWith(".md") || f.endsWith(".mdx");
const slugOf = (f: string) => f.replace(/\.(md|mdx)$/, "");
const byDate = (a: ContentEntry, b: ContentEntry) =>
  String(b.data.date ?? "").localeCompare(String(a.data.date ?? "")) ||
  a.slug.localeCompare(b.slug);

// Per-locale content layout: flat `<dir>/*.md` are the DEFAULT-locale entries
// (today's behavior, zero migration); each `<dir>/<locale>/*.md` subdir holds
// that locale's variants. Isomorphic to the routing default (unprefixed) vs
// locale (prefixed) split. A single-locale collection has no subdirs → `byLocale`
// is empty and everything below collapses to the flat path.
export type ScannedCollection = {
  default: ContentEntry[];
  byLocale: Record<string, ContentEntry[]>;
};

// BCP-47-shaped tag (language + optional script/region/variant subtags). Used to
// decide whether a subdir is a locale bucket WITHOUT the i18n config: it accepts
// `de`, `fr`, `zh-TW`, `pt-BR` and rejects `images`, `drafts`, `assets` — so a
// stray folder can't become a phantom locale. Pass `knownLocales` for exact,
// config-driven validation (the stronger check once the locale set is threaded in).
const LOCALE_DIR = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
function isLocaleDir(name: string, known?: readonly string[]): boolean {
  return known ? known.includes(name) : LOCALE_DIR.test(name);
}

export function scanCollection(dir: string, knownLocales?: readonly string[]): ScannedCollection {
  const def: ContentEntry[] = [];
  const byLocale: Record<string, ContentEntry[]> = {};
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      // Only a configured locale (or, without a list, a BCP-47-shaped name) is a
      // locale bucket — a stray content/<col>/images/ is NOT a phantom "images".
      if (!isLocaleDir(ent.name, knownLocales)) continue;
      const locale = ent.name;
      const sub = join(dir, locale);
      byLocale[locale] = readdirSync(sub)
        .filter(isMd)
        .map((f) => loadEntry(join(sub, f), slugOf(f), locale))
        .sort(byDate);
    } else if (isMd(ent.name)) {
      def.push(loadEntry(join(dir, ent.name), slugOf(ent.name)));
    }
  }
  def.sort(byDate);
  return { default: def, byLocale };
}

/** All entries in a content directory, newest-first by `date` (then slug). With
 *  a `locale`, each entry is its locale variant when present, else the default
 *  (so a reader sees the whole collection, localized where available). */
export function collection(dir: string, locale?: string): ContentEntry[] {
  const { default: def, byLocale } = scanCollection(dir);
  if (!locale || !byLocale[locale]) return def;
  const variants = new Map(byLocale[locale].map((e) => [e.slug, e]));
  return def.map((e) => variants.get(e.slug) ?? e).sort(byDate);
}

// Probe `<dir>/<slug>.{md,mdx}`, tagging the result with `locale`. null if absent.
function probe(dir: string, slug: string, locale?: string): ContentEntry | null {
  for (const ext of [".md", ".mdx"]) {
    try {
      return loadEntry(join(dir, slug + ext), slug, locale);
    } catch {
      /* try next ext */
    }
  }
  return null;
}

/** One entry by slug, or null. With a `locale`, prefer `<dir>/<locale>/<slug>`,
 *  falling back to the flat default (a dev-warn flags a partial translation).
 *  `fallback: false` is STRICT — a missing variant returns null (so a route can
 *  404 rather than serve default-language content). */
export function entry(
  dir: string,
  slug: string,
  locale?: string,
  opts?: { fallback?: boolean },
): ContentEntry | null {
  // Guard the slug — it comes from the URL.
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  if (!locale) return probe(dir, slug);
  const variant = probe(join(dir, locale), slug, locale);
  if (variant) return variant;
  if (opts?.fallback === false) return null; // strict — no default-language bleed
  const fallback = probe(dir, slug);
  // The locale is otherwise translated here, but not this slug → a gap worth a
  // dev signal (silent in production builds, where NODE_ENV is baked).
  if (fallback && existsSync(join(dir, locale))) {
    console.warn(`[june content] ${slug}: no "${locale}" variant — served default`);
  }
  return fallback;
}

// Generate the frozen `app/_content.ts` module text from `content/<collection>/`.
// The FREEZE that removes node:fs from the worker graph: routes import frozen
// entries + finders instead of reading the filesystem at request time.
//
// Off by absence: a collection with no `<locale>/` subdirs emits EXACTLY today's
// shape (`POSTS` array + `post(slug)` finder) — single-locale apps are unchanged.
// A collection WITH locale subdirs additionally emits a slug→locale→entry map, a
// locale-aware `post(slug, locale?)` finder (variant → flat default, dev-warn on a
// partial-translation miss, tree-shaken in production), and a locale-merged
// `posts(locale?)` lister.
export function generateContentModule(
  contentDir: string,
  knownLocales?: readonly string[],
): { code: string; names: string[] } {
  const strip = (e: ContentEntry) => ({
    slug: e.slug,
    data: e.data,
    body: e.body,
    original: e.original,
    html: e.html,
    ...(e.locale ? { locale: e.locale } : {}),
  });
  const dirs = readdirSync(contentDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const names: string[] = [];
  let anyLocale = false;
  let body = "";
  for (const d of dirs) {
    const { default: def, byLocale } = scanCollection(join(contentDir, d.name), knownLocales);
    const CONST = d.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    // Singular finder name: posts → post, otherwise <name>Entry.
    const finder = d.name.endsWith("s") ? d.name.slice(0, -1) : `${d.name}Entry`;
    body += `export const ${CONST}: ContentEntry[] = ${JSON.stringify(def.map(strip), null, 2)};\n`;
    if (Object.keys(byLocale).length === 0) {
      body += `export const ${finder} = (slug: string): ContentEntry | null => ${CONST}.find((p) => p.slug === slug) ?? null;\n`;
    } else {
      anyLocale = true;
      const map: Record<string, Record<string, unknown>> = {};
      for (const [loc, entries] of Object.entries(byLocale)) {
        for (const e of entries) (map[loc] ??= {})[e.slug] = strip(e);
      }
      body += `const ${CONST}_L: Record<string, Record<string, ContentEntry>> = ${JSON.stringify(map, null, 2)};\n`;
      body +=
        `export const ${finder} = (slug: string, locale?: string, opts?: { fallback?: boolean }): ContentEntry | null => {\n` +
        `  const v = locale ? ${CONST}_L[locale]?.[slug] : undefined;\n` +
        `  if (v) return v;\n` +
        `  if (opts?.fallback === false) return null;\n` +
        `  const d = ${CONST}.find((p) => p.slug === slug) ?? null;\n` +
        `  if (process.env.NODE_ENV !== "production" && locale && ${CONST}_L[locale] && d) console.warn(\`[june content] ${d.name}/\${slug}: no "\${locale}" variant — served default\`);\n` +
        `  return d;\n};\n`;
      body += `export const ${d.name} = (locale?: string): ContentEntry[] => locale && ${CONST}_L[locale] ? ${CONST}.map((p) => ${CONST}_L[locale]![p.slug] ?? p) : ${CONST};\n`;
    }
    names.push(d.name);
  }
  const entryType = anyLocale
    ? "export type ContentEntry = { slug: string; data: Record<string, string | string[]>; body: string; original: string; html: string; locale?: string };\n"
    : "export type ContentEntry = { slug: string; data: Record<string, string | string[]>; body: string; original: string; html: string };\n";
  const code =
    "// AUTO-GENERATED by `june build` — edit content/**/*.md, not this file.\n" + entryType + body;
  return { code, names };
}
