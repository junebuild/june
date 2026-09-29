// The file-route matcher: a recursive-descent walk over the app directory that
// turns a URL into (page file, params, segment chain). The SAME conventions
// drive `june dev` and `june build` (rebuild-plan Phase 3) — one matcher, no
// drift between what dev serves and what the build freezes.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { compareSegments, parseSegment } from "./route-rank";

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

// app/_middleware.* — the pre-route middleware seam (a `_` file, so never a
// route): runs after the agent surface, before route resolution. Return null to
// pass; return a Response to short-circuit. Two cautions (see MiddlewareHandler):
// don't authorize here (that's the single run(input, ctx) gate), and because it
// runs BEFORE routes, over-broad matching can shadow a page. For a custom
// endpoint (binary, webhook), prefer a route.* resource route instead.
// `_extra` is the deprecated former name (warned + still honored for one cycle).
// Dev and the build look it up through this ONE helper so the conventions can't
// drift.
export function findMiddlewareFile(appDir: string): string | null {
  for (const ext of routeExtensions) {
    const f = join(appDir, `_middleware${ext}`);
    if (existsSync(f)) return f;
  }
  for (const ext of routeExtensions) {
    const f = join(appDir, `_extra${ext}`);
    if (existsSync(f)) {
      console.warn("[june] app/_extra is deprecated — rename it to app/_middleware.");
      return f;
    }
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

// app/**/route.* — a RESOURCE route: a handler returning a raw Response (binary,
// custom content-type, webhook), not a React page. It's a first-class route (in
// the route table, params from the path, resolved by the SAME matcher), so it
// can't shadow pages by accident and doesn't need hand-rolled url matching.
export function isResourceFile(file: string): boolean {
  return baseName(file) === "route";
}

// Special (never-a-route) files that shape the segment tree.
const SPECIAL_FILES = new Set(["layout", "loading", "error", "not-found"]);

function isSpecialFile(file: string) {
  return SPECIAL_FILES.has(baseName(file));
}

const isRouteGroup = (name: string) => /^\(.+\)$/.test(name);
const isParamDir = (name: string) => parseSegment(name).kind === "param";
// [[slug]] / [[...slug]] — match like their required forms, and ALSO match the
// segment being absent (the param is then simply missing from ctx.params).
const isOptionalDir = (name: string) => parseSegment(name).kind === "optional";
const isOptionalCatchAllDir = (name: string) => parseSegment(name).kind === "optionalCatchAll";
const isCatchAllDir = (name: string) => parseSegment(name).kind === "catchAll";
const paramName = (name: string) => parseSegment(name).name!;

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

  if (parts.at(-1) === "page" || parts.at(-1) === "index" || parts.at(-1) === "route") {
    parts.pop();
  }

  return `/${parts.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

// Recursive-descent matcher over the app directory. Priority at every level:
// exact static segment > [param] > [...catchAll], required before optional, ties
// by name (route-rank.ts — the built worker sorts its route table by the same
// ranking); `_`-prefixed entries never participate. Route groups `(name)` are
// invisible in the URL, so they are invisible to ranking too: a group's children
// compete as siblings of the level the group sits in (a grouped `[slug]` never
// shadows a static sibling), while the group still contributes its layout.
// Returns the page file, accumulated params (catch-all joins with "/"), and the
// chain of segments (with their special files) from the app root to the page.
export async function matchRouteTree(
  appDir: string,
  pathname: string,
  options: MatchOptions = {},
): Promise<RouteTreeMatch | null> {
  const urlSegments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  // One URL level = this dir plus every route group under it (groups nest), each
  // with the segment chain down to it: the dir first, then groups in name order.
  type Level = { dir: string; entries: DirEntry[]; segments: SegmentMatch[] };
  async function levelAt(dir: string, chain: SegmentMatch[]): Promise<Level[]> {
    // Ranked, not readdir order, so the pick is the same on every filesystem.
    const entries = (await listDir(dir)).sort((a, b) => compareSegments(a.name, b.name));
    const segments = [...chain, segmentAt(dir, entries)];
    const levels: Level[] = [{ dir, entries, segments }];
    for (const e of entries) {
      if (e.dir && isRouteGroup(e.name)) levels.push(...(await levelAt(join(dir, e.name), segments)));
    }
    return levels;
  }

  // A URL level can span several real dirs: `(a)/blog` and `(b)/blog` are both
  // `/blog`, so they descend TOGETHER — otherwise (a)/blog/[slug] would answer
  // /blog/about before (b)/blog/about was ever seen.
  type Node = { dir: string; chain: SegmentMatch[] };

  async function descend(
    nodes: Node[],
    rest: string[],
    params: Record<string, string>,
  ): Promise<RouteTreeMatch | null> {
    const levels = (await Promise.all(nodes.map((n) => levelAt(n.dir, n.chain)))).flat();

    // Terminal: URL consumed → find the page at this level, groups included,
    // and only then a resource route: a page beats a route.ts at the same path
    // even when the two sit in different groups (the worker ranks them so).
    if (rest.length === 0) {
      for (const base of [["page", "index"], ["route"]]) {
        for (const { dir: d, entries, segments } of levels) {
          const file = base.map((b) => fileFor(entries, d, b)).find(Boolean);
          if (file) return { file, params, segments };
        }
      }
    } else if (!options.pageConvention && rest.length === 1) {
      // Legacy flat convention: a non-special leaf FILE names the final segment
      // (examples/rsc: about.tsx → /about). Only valid for the last segment.
      for (const { dir: d, entries, segments } of levels) {
        const leaf = fileFor(entries, d, rest[0]!);
        if (leaf && !isSpecialFile(leaf) && !isPageFile(leaf)) return { file: leaf, params, segments };
      }
    }

    // Every child dir at this level, groups flattened and same names merged, in
    // rank order.
    const children = new Map<string, Node[]>();
    for (const lv of levels) {
      for (const e of lv.entries) {
        if (!e.dir || isRouteGroup(e.name)) continue;
        const node = { dir: join(lv.dir, e.name), chain: lv.segments };
        const same = children.get(e.name);
        if (same) same.push(node);
        else children.set(e.name, [node]);
      }
    }
    const names = [...children.keys()].sort(compareSegments);

    if (rest.length === 0) {
      // Optional segments match ABSENCE too: descend without consuming and
      // without setting the param.
      for (const name of names) {
        if (!(isOptionalDir(name) || isOptionalCatchAllDir(name))) continue;
        const hit = await descend(children.get(name)!, [], params);
        if (hit) return hit;
      }
      return null;
    }
    const [head, ...tail] = rest as [string, ...string[]];

    for (const name of names) {
      const into = children.get(name)!;
      let hit: RouteTreeMatch | null = null;
      if (isParamDir(name) || isOptionalDir(name)) {
        // [param] and [[param]] consume one segment
        hit = await descend(into, tail, { ...params, [paramName(name)]: head });
      } else if (isCatchAllDir(name) || isOptionalCatchAllDir(name)) {
        // [...catchAll] and [[...catchAll]] consume everything remaining
        hit = await descend(into, [], { ...params, [paramName(name)]: rest.join("/") });
      } else if (name === head) {
        hit = await descend(into, tail, params); // exact static dir
      }
      if (hit) return hit;
    }

    return null;
  }

  return descend([{ dir: appDir, chain: [] }], urlSegments, {});
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
    if (options.pageConvention && !isPageFile(file) && !isResourceFile(file)) return false;
    return true;
  });
}

// All PAGE route paths under appDir (for sitemap / llms.txt / api-catalog).
// Resource routes (route.*) are excluded — they're machine endpoints (og images,
// webhooks), not pages, so they don't belong in the human/agent sitemap.
export async function listRoutes(
  appDir: string,
  options: MatchOptions = {},
): Promise<string[]> {
  const files = (await routeFiles(appDir, options)).filter((file) => !isResourceFile(file));
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
