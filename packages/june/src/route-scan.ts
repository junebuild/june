// Filesystem route discovery for the build: walk app/ for page.* files and
// merge in the framework's .june/routes/ slot. Extracted from build.ts so the
// scan/merge rules live beside each other, in one place — buildManifest and
// juneBuild consume the SAME merged list via scanAppRoutes (they previously
// each inlined the merge).

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { parseSegment } from "./route-rank";

// The segment layout CHAIN root→leaf: every directory level (route groups
// included) may contribute a layout.* that wraps routes below it.
export type RouteEntry = {
  path: string;
  file: string;
  dynamic: boolean;
  resource?: boolean; // a route.* resource route (raw-Response handler), not a page
  generated?: boolean; // scanned from .june/routes/ — ranks after every app/ route, as in dev
  layouts: string[];
  loading?: string; // nearest loading.tsx up the tree → streaming Suspense fallback
};

const PAGE_BASENAMES = new Set(["page", "index"]);
const ROUTE_EXTS = [".tsx", ".jsx", ".ts", ".js"];

const isRouteGroup = (name: string) => /^\(.+\)$/.test(name);

function segmentFile(dir: string, base: string): string | undefined {
  return ROUTE_EXTS.map((e) => join(dir, `${base}${e}`)).find(existsSync);
}

// Walk app/ for page.* files → route paths (mirrors router.ts conventions:
// route groups vanish from URLs, `_`-prefixed entries are private), carrying the
// layout chain accumulated from each directory level.
export async function scanRoutes(
  appDir: string,
  dir = appDir,
  layouts: string[] = [],
  out: RouteEntry[] = [],
  loading?: string,
): Promise<RouteEntry[]> {
  const ownLayout = segmentFile(dir, "layout");
  const chain = ownLayout ? [...layouts, ownLayout] : layouts;
  const nearestLoading = segmentFile(dir, "loading") ?? loading;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await scanRoutes(appDir, full, chain, out, nearestLoading);
      continue;
    }
    const ext = e.name.match(/\.[^.]+$/)?.[0] ?? "";
    if (!ROUTE_EXTS.includes(ext)) continue;
    const base = basename(e.name, ext);
    const resource = base === "route";
    if (!PAGE_BASENAMES.has(base) && !resource) continue;
    const relDir = relative(appDir, dir);
    const segments = relDir === "" ? [] : relDir.split(sep).filter((s) => !isRouteGroup(s));
    const path = "/" + segments.join("/");
    out.push({
      path: path === "/" ? "/" : path,
      file: full,
      dynamic: /\[.+\]/.test(path),
      resource,
      layouts: chain,
      loading: nearestLoading,
    });
  }
  return out;
}

// Merge routes: app/ takes priority over .june/routes/ (app/ is the escape hatch).
// .june/routes/ is the convention slot for framework-generated routes (e.g. kura
// writes its docs/search/og routes there so the user never manages boilerplate).
export async function scanAppRoutes(appRoot: string): Promise<RouteEntry[]> {
  const appDir = join(appRoot, "app");
  const juneRoutesDir = join(appRoot, ".june", "routes");
  const appRoutes = await scanRoutes(appDir);
  const frameworkRoutes = existsSync(juneRoutesDir) ? await scanRoutes(juneRoutesDir) : [];
  const problems = routeProblems([appRoutes, frameworkRoutes], appRoot);
  if (problems) throw new Error(problems);
  const appPaths = new Set(appRoutes.map((r) => r.path));
  const generated = frameworkRoutes
    .filter((r) => !appPaths.has(r.path))
    .map((r) => ({ ...r, generated: true }));
  return [...appRoutes, ...generated].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

// Two route files in ONE tree that resolve to the same URL: `(a)/about/page.tsx`
// and `(b)/about/page.tsx` (groups vanish from the URL), or `page.tsx` next to
// `index.tsx`. Pages and resource routes are counted apart — a page and a
// route.ts at the same path are allowed, in one dir or across groups (the page
// wins). No winner is defined for the rest: dev
// would pick by group order and the worker by scan order, so the build refuses
// them and dev reports them (#316).
export function routeConflicts(routes: RouteEntry[]): Array<{ path: string; files: string[] }> {
  const byKey = new Map<string, { path: string; files: string[] }>();
  for (const r of routes) {
    const key = `${r.resource ? "route" : "page"} ${r.path}`;
    const hit = byKey.get(key);
    if (hit) hit.files.push(r.file);
    else byKey.set(key, { path: r.path, files: [r.file] });
  }
  return [...byKey.values()]
    .filter((c) => c.files.length > 1)
    .map((c) => ({ path: c.path, files: c.files.sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// An optional or catch-all segment ([[x]], [...x], [[...x]]) must END the route
// path (#315, the Next.js rule, opinionated). Mid-path there is no behavior to
// keep: dev never matched past a catch-all nor skipped a mid-path [[x]], while
// the worker's regex did both. A (group) after it is not a URL segment, so it's
// fine. Returns the offending routes, path-sorted.
const ENDS_PATH = new Set(["optional", "catchAll", "optionalCatchAll"]);
const beforeLast = (path: string) => path.split("/").filter(Boolean).slice(0, -1).map((s) => parseSegment(s).kind);

export function misplacedSegments(routes: RouteEntry[]): RouteEntry[] {
  return routes
    .filter((r) => beforeLast(r.path).some((k) => ENDS_PATH.has(k)))
    .sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file));
}

// Every route-table problem the build refuses and dev reports, as one message
// (null when there are none). Each tree (app/, .june/routes/) is checked on its
// own: the same path in both is not a conflict — app/ wins.
export function routeProblems(trees: RouteEntry[][], appRoot: string): string | null {
  const rel = (f: string) => relative(appRoot, f).split(sep).join("/");
  const sections: string[] = [];

  const conflicts = trees.flatMap(routeConflicts);
  if (conflicts.length) {
    sections.push(
      "[june] more than one route file resolves to the same path — keep one per path:\n" +
        conflicts.map((c) => `  ${c.path}: ${c.files.map(rel).join(", ")}`).join("\n"),
    );
  }

  const misplaced = trees.flatMap(misplacedSegments);
  if (misplaced.length) {
    const lines = misplaced.map((r) => `  ${r.path}: ${rel(r.file)}`);
    // Developers (and models) read [[x]] the SvelteKit way, skippable anywhere;
    // say so when a single optional is the culprit, and point at the real tool.
    if (misplaced.some((r) => beforeLast(r.path).includes("optional"))) {
      lines.push(
        "  Unlike SvelteKit, June does not skip a [[param]] mid-path. For a locale prefix, set i18n.locales in june.config.ts instead of a [[lang]] directory.",
      );
    }
    sections.push(
      "[june] an optional or catch-all segment must be the last segment of a route path — nothing may follow it:\n" +
        lines.join("\n"),
    );
  }

  return sections.length ? sections.join("\n") : null;
}
