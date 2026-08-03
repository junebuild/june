// Filesystem route discovery for the build: walk app/ for page.* files and
// merge in the framework's .june/routes/ slot. Extracted from build.ts so the
// scan/merge rules live beside each other, in one place — buildManifest and
// juneBuild consume the SAME merged list via scanAppRoutes (they previously
// each inlined the merge).

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

// The segment layout CHAIN root→leaf: every directory level (route groups
// included) may contribute a layout.* that wraps routes below it.
export type RouteEntry = {
  path: string;
  file: string;
  dynamic: boolean;
  resource?: boolean; // a route.* resource route (raw-Response handler), not a page
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
  const appPaths = new Set(appRoutes.map((r) => r.path));
  return [...appRoutes, ...frameworkRoutes.filter((r) => !appPaths.has(r.path))].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}
