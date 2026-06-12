// The file-route matcher: a recursive-descent walk over the app directory that
// turns a URL into (page file, params, segment chain). The SAME conventions
// drive `june dev` and `june build` (rebuild-plan Phase 3) — one matcher, no
// drift between what dev serves and what the build freezes.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type RouteMatch = {
  file: string;
  params: Record<string, string>;
};

// One directory level of a matched route, root → … → the page's own dir. Each
// level contributes its special files to the rendered tree: layout wraps,
// loading becomes a Suspense fallback, error becomes the recovery UI for the
// segment's load/render, not-found resolves 404s for paths under it.
export type SegmentMatch = {
  dir: string;
  layout?: string;
  loading?: string;
  error?: string;
  notFound?: string;
};

export type RouteTreeMatch = {
  file: string;
  params: Record<string, string>;
  segments: SegmentMatch[];
};

const routeExtensions = new Set([".tsx", ".jsx", ".ts", ".js"]);

// app/_extra.* — the pre-route escape hatch (a `_` file, so never a route).
// Dev and the build look it up through this ONE helper so the conventions
// cannot drift.
export function findExtraFile(appDir: string): string | null {
  for (const ext of routeExtensions) {
    const f = join(appDir, `_extra${ext}`);
    if (existsSync(f)) return f;
  }
  return null;
}

export type MatchOptions = {
  // When true, only `page.*` and `index.*` files are routes. This lets a route
  // folder colocate `model.ts`, `actions.ts`, `queries.ts`, `_components/`,
  // `_tests/` without them becoming accidental routes.
  pageConvention?: boolean;
};

function baseName(file: string) {
  return (file.split(sep).pop() ?? "").replace(/\.[^.]+$/, "");
}

function isPageFile(file: string) {
  const base = baseName(file);
  return base === "page" || base === "index";
}

// Special (never-a-route) files that shape the segment tree.
const SPECIAL_FILES = new Set(["layout", "loading", "error", "not-found"]);

function isSpecialFile(file: string) {
  return SPECIAL_FILES.has(baseName(file));
}

const isRouteGroup = (name: string) => /^\(.+\)$/.test(name);
const isParamDir = (name: string) => /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.test(name);
const isCatchAllDir = (name: string) => /^\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]$/.test(name);
const paramName = (name: string) => name.replace(/^\[(\.\.\.)?|\]$/g, "");

type DirEntry = { name: string; dir: boolean };

async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

function fileFor(entries: DirEntry[], dir: string, base: string): string | undefined {
  for (const ext of [".tsx", ".jsx", ".ts", ".js"]) {
    if (entries.some((e) => !e.dir && e.name === base + ext)) return join(dir, base + ext);
  }
  return undefined;
}

function segmentAt(dir: string, entries: DirEntry[]): SegmentMatch {
  return {
    dir,
    layout: fileFor(entries, dir, "layout"),
    loading: fileFor(entries, dir, "loading"),
    error: fileFor(entries, dir, "error"),
    notFound: fileFor(entries, dir, "not-found"),
  };
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );

  return files.flat();
}

function routePath(appDir: string, file: string) {
  const rel = relative(appDir, file).split(sep).join("/");
  const withoutExtension = rel.replace(/\.[^.]+$/, "");
  // Route groups shape the filesystem, not the URL.
  const parts = withoutExtension.split("/").filter((p) => !isRouteGroup(p));

  if (parts.at(-1) === "page" || parts.at(-1) === "index") {
    parts.pop();
  }

  return `/${parts.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

// Recursive-descent matcher over the app directory. Priority at every level:
// exact static segment > [param] > [...catchAll]; route groups `(name)` descend
// without consuming a URL segment; `_`-prefixed entries never participate.
// Returns the page file, accumulated params (catch-all joins with "/"), and the
// chain of segments (with their special files) from the app root to the page.
export async function matchRouteTree(
  appDir: string,
  pathname: string,
  options: MatchOptions = {},
): Promise<RouteTreeMatch | null> {
  const urlSegments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  async function descend(
    dir: string,
    rest: string[],
    params: Record<string, string>,
    chain: SegmentMatch[],
  ): Promise<RouteTreeMatch | null> {
    const entries = await listDir(dir);
    const segments = [...chain, segmentAt(dir, entries)];

    // Terminal: URL consumed → find the page in this dir.
    if (rest.length === 0) {
      const page = fileFor(entries, dir, "page") ?? fileFor(entries, dir, "index");
      if (page) return { file: page, params, segments };
    } else if (!options.pageConvention) {
      // Legacy flat convention: a non-special leaf FILE names the final segment
      // (examples/rsc: about.tsx → /about). Only valid for the last segment.
      if (rest.length === 1) {
        const leaf = fileFor(entries, dir, rest[0]!);
        if (leaf && !isSpecialFile(leaf) && !isPageFile(leaf)) {
          return { file: leaf, params, segments };
        }
      }
    }

    // Route groups: try descending into every (group) without consuming URL.
    for (const e of entries) {
      if (!e.dir || !isRouteGroup(e.name)) continue;
      const hit = await descend(join(dir, e.name), rest, params, segments);
      if (hit) return hit;
    }

    if (rest.length === 0) return null;
    const [head, ...tail] = rest as [string, ...string[]];

    // 1) exact static dir
    const exact = entries.find((e) => e.dir && e.name === head);
    if (exact) {
      const hit = await descend(join(dir, head), tail, params, segments);
      if (hit) return hit;
    }
    // 2) [param] dirs
    for (const e of entries) {
      if (!e.dir || !isParamDir(e.name)) continue;
      const hit = await descend(
        join(dir, e.name),
        tail,
        { ...params, [paramName(e.name)]: head },
        segments,
      );
      if (hit) return hit;
    }
    // 3) [...catchAll] dirs consume everything remaining
    for (const e of entries) {
      if (!e.dir || !isCatchAllDir(e.name)) continue;
      const hit = await descend(
        join(dir, e.name),
        [],
        { ...params, [paramName(e.name)]: rest.join("/") },
        segments,
      );
      if (hit) return hit;
    }

    return null;
  }

  return descend(appDir, urlSegments, {}, []);
}

// 404 path: walk the longest matchable STATIC prefix of the URL collecting
// segments, so the not-found page renders inside the layouts it lives under;
// the not-found file is the nearest one up that chain.
export async function resolveNotFound(
  appDir: string,
  pathname: string,
): Promise<{ segments: SegmentMatch[]; notFound?: string }> {
  const urlSegments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const segments: SegmentMatch[] = [];
  let dir = appDir;

  for (let i = 0; i <= urlSegments.length; i++) {
    const entries = await listDir(dir);
    segments.push(segmentAt(dir, entries));
    if (i === urlSegments.length) break;
    const next = entries.find((e) => e.dir && e.name === urlSegments[i]);
    if (!next) break;
    dir = join(dir, next.name);
  }

  const notFound = [...segments].reverse().find((s) => s.notFound)?.notFound;
  return { segments, notFound };
}

// Every route FILE under appDir (absolute paths). Special files
// (layout/loading/error/not-found) and `_`-prefixed entries are never routes.
// Used by discovery (route list) and by the dev-server warmup that imports each
// route module so its defineAction() side effects register before /mcp is hit.
export async function routeFiles(
  appDir: string,
  options: MatchOptions = {},
): Promise<string[]> {
  return (await walk(appDir)).filter((file) => {
    if (!routeExtensions.has(file.match(/\.[^.]+$/)?.[0] ?? "")) return false;
    if (isSpecialFile(file)) return false;
    if (file.split(sep).some((p) => p.startsWith("_"))) return false;
    if (options.pageConvention && !isPageFile(file)) return false;
    return true;
  });
}

// All route paths under appDir (for sitemap / llms.txt / api-catalog).
export async function listRoutes(
  appDir: string,
  options: MatchOptions = {},
): Promise<string[]> {
  const files = await routeFiles(appDir, options);
  return [...new Set(files.map((file) => routePath(appDir, file)))].sort();
}

// Flat-shaped result; delegates to the tree matcher.
export async function matchRoute(
  appDir: string,
  pathname: string,
  options: MatchOptions = {},
): Promise<RouteMatch | null> {
  const tree = await matchRouteTree(appDir, pathname, options);
  return tree ? { file: tree.file, params: tree.params } : null;
}
