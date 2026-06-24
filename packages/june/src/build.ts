// `june build` — produce a Workers-ready bundle from a June app.
//
// What the dev server discovers at REQUEST time (filesystem routes,
// june.config.ts, content/ markdown), the build discovers ONCE and FREEZES into
// a static manifest fed to createWorker(). The built worker renders through the
// SAME pipeline as dev (pipeline.ts), so its surfaces are byte-equivalent —
// proven by test/parity.test.ts, not hoped for.
//
// Two entry points:
//   buildManifest(appRoot) → an in-process WorkerManifest (freeze only; used by
//     the parity test and by prerender — same render path as the bundle).
//   juneBuild(appRoot)     → the full build: content freeze + generated entry +
//     Rolldown bundle (workerd conditions, binary externals) +
//     prerender-through-the-worker + wrangler config.
//
// REMINDER #4: nothing in the worker graph may statically import node:*. The
// content freeze (content/*.md → app/_content.ts) is what removes fs from the
// dynamic route's graph; the worker reads frozen data, never the filesystem.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { loadJuneConfig } from "./config-loader";
import { resolveAgent, resolveClientRouter, resolveSpeculationRules } from "@junejs/core/config";
import { buildLinkHeader } from "@junejs/core/discovery";
import { routeFromModule, type BrandedRoute } from "@junejs/core/route";
import { workers, type JuneAdapter, type ResourcePlan } from "./adapter";
import type { DocumentConfig } from "@junejs/core/document";
import { generateContentModule } from "./content";
import { createWorker, type WorkerManifest } from "./worker";
import { findMiddlewareFile } from "./router";
import { resolveBoundary } from "./segment";
import type { ExtraHandler, LayoutComponent, LoadingComponent, ResourceHandler } from "./pipeline";
import { findClientEntry, bundleClientToFile, CLIENT_SCRIPT_URL } from "./client-bundle";
import { generateIslandRegistry } from "./island-registry";
import { buildRsc, findRscRoutes } from "./rsc-build";
import { cssTargets, findGlobalCss, globalCssUsesTailwind, minifyCss, processCss, STYLES_URL } from "./css";
import { buildModuleCss, rolldownCssModulesPlugin, registerCssModules } from "./css-modules";

export type BuildResult = {
  outFile: string;
  routes: string[];
  dynamicRoutes: string[];
  contentCollections: string[];
  prerendered: string[];
};

// The segment layout CHAIN root→leaf: every directory level (route groups
// included) may contribute a layout.* that wraps routes below it.
type RouteEntry = {
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

// Bun built-ins (`bun`, `bun:sqlite`, …) exist only at the Bun runtime and must never enter the
// workerd graph. Marking them external keeps rolldown from constant-folding the `const x = "bun";
// import(x)` runtime guard (in @junejs/core's cache.ts) and warning UNRESOLVED_IMPORT. Exported so
// the build keeps externalizing them — see test/build-externals.test.ts.
export const isBunSpecifier = (id: string): boolean => id === "bun" || id.startsWith("bun:");

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

// content/<collection>/*.md → app/_content.ts (the build-time content manifest).
// This is the FREEZE that removes node:fs from the worker graph: routes import
// frozen entries from ./_content instead of reading the filesystem at request.
export async function generateContent(appRoot: string): Promise<string[]> {
  const contentDir = join(appRoot, "content");
  if (!existsSync(contentDir)) return [];
  // Emission (incl. the per-locale layout) lives in ./content so it's pure and
  // unit-testable; this stays the thin fs wrapper.
  const { code, names } = generateContentModule(contentDir);
  if (names.length === 0) return [];
  await writeFile(join(appRoot, "app", "_content.ts"), code);
  return names;
}

// Freeze june.config.ts → the serializable bits the worker inlines.
export async function freezeConfig(appRoot: string): Promise<{
  document: DocumentConfig;
  agent: WorkerManifest["agent"];
  i18n: WorkerManifest["i18n"];
  earlyHints: string[];
  buildExternal: string[];
}> {
  const cfg = await loadJuneConfig(appRoot);
  // An app with a client entry gets the islands runtime URL frozen into its
  // document. Detected HERE (not just in juneBuild) so the prerender path —
  // which re-freezes through buildManifest — sets the SAME clientScript, keeping
  // prerendered pages byte-equivalent to the live worker (parity).
  const hasClient = findClientEntry(join(appRoot, "app")) !== undefined;
  const hasCss = findGlobalCss(join(appRoot, "app")) !== null;
  return {
    document: {
      site: cfg.site ?? {},
      speculationRules: resolveSpeculationRules(cfg.speculation ?? undefined),
      speculationDelivery: "inline",
      viewTransitions: cfg.viewTransitions ?? true,
      // Default the baseline reset OFF when the app uses Tailwind (its Preflight is the reset).
      cssReset: cfg.cssReset ?? !globalCssUsesTailwind(join(appRoot, "app")),
      clientRouter: resolveClientRouter(cfg.clientRouter),
      clientScript: hasClient ? CLIENT_SCRIPT_URL : null,
      styles: hasCss ? STYLES_URL : null,
    },
    agent: resolveAgent(cfg.agent),
    // Pass i18n through as-is: the in-process buildManifest keeps a resolveLocale
    // hook (parity test), and the codegen JSON.stringify below drops the function
    // (worker hook support is the codegen pass — see the manifest field comment).
    i18n: cfg.i18n,
    earlyHints: cfg.earlyHints ?? [],
    buildExternal: cfg.build?.external ?? [],
  };
}

type ImportedLayout = { component: LayoutComponent; boundary: boolean };
async function importLayout(file: string): Promise<ImportedLayout | null> {
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: LayoutComponent;
    segmentBoundary?: unknown;
  };
  return typeof mod.default === "function"
    ? { component: mod.default, boundary: mod.segmentBoundary === true }
    : null;
}

// The FREEZE, in-process: import route modules + layouts, build the manifest a
// createWorker() can run immediately. Used by prerender and by the parity test
// (its render path is identical to the Rolldown-bundled worker).
export async function buildManifest(appRoot: string): Promise<WorkerManifest> {
  const appDir = join(appRoot, "app");
  const frozen = await freezeConfig(appRoot);
  const scanned = (await scanRoutes(appDir)).sort((a, b) => a.path.localeCompare(b.path));

  const layoutCache = new Map<string, ImportedLayout | null>();
  const loadCached = async (f: string): Promise<ImportedLayout | null> => {
    if (!layoutCache.has(f)) layoutCache.set(f, await importLayout(f));
    return layoutCache.get(f) ?? null;
  };
  // The chain (root→leaf) + boundary index + shell key, via the SHARED resolver
  // (the one place the deepest-wins rule lives), so the frozen manifest and the
  // dev resolver can't drift — the parity contract.
  const componentsFor = async (
    files: string[],
  ): Promise<{ chain: LayoutComponent[]; boundaryIndex: number | null; key: string | null }> => {
    const items = [];
    for (const f of files) {
      const c = await loadCached(f);
      items.push({ file: f, entry: c?.component ?? null, boundary: !!c?.boundary });
    }
    return resolveBoundary(items);
  };

  const loadingCache = new Map<string, LoadingComponent | null>();
  const loadingFor = async (file?: string): Promise<LoadingComponent | undefined> => {
    if (!file) return undefined;
    if (!loadingCache.has(file)) {
      const loaded = await importLayout(file);
      loadingCache.set(file, loaded ? (loaded.component as LoadingComponent) : null);
    }
    return loadingCache.get(file) ?? undefined;
  };

  const routes: Record<string, BrandedRoute> = {};
  const dynamicRoutes: Array<{ pattern: string; def: BrandedRoute }> = [];
  const resourceRoutes: Array<{ pattern: string; handler: ResourceHandler }> = [];
  const layoutChains: Record<string, LayoutComponent[]> = {};
  const layoutBoundaries: Record<string, { index: number; key: string }> = {};
  const loadings: Record<string, LoadingComponent> = {};

  for (const r of scanned) {
    const mod = await import(pathToFileURL(r.file).href);
    // Resource route (route.*): the default export is the Response handler.
    if (r.resource) {
      const handler = (mod as { default?: unknown }).default;
      if (typeof handler === "function") resourceRoutes.push({ pattern: r.path, handler: handler as ResourceHandler });
      continue;
    }
    const def = routeFromModule(mod);
    if (!def) continue;
    const { chain, boundaryIndex, key } = await componentsFor(r.layouts);
    const loading = await loadingFor(r.loading);
    if (r.dynamic) {
      dynamicRoutes.push({ pattern: r.path, def });
      layoutChains[r.path] = chain;
    } else {
      routes[r.path] = def;
      layoutChains[r.path] = chain;
    }
    if (boundaryIndex !== null && key !== null) layoutBoundaries[r.path] = { index: boundaryIndex, key };
    if (loading) loadings[r.path] = loading;
  }

  let extra: ExtraHandler | undefined;
  const extraFile = findMiddlewareFile(appDir);
  if (extraFile) {
    const mod = (await import(pathToFileURL(extraFile).href)) as { default?: unknown };
    if (typeof mod.default === "function") extra = mod.default as ExtraHandler;
  }

  return {
    routes,
    dynamicRoutes,
    resourceRoutes,
    layoutChains,
    layoutBoundaries,
    loadings,
    document: frozen.document,
    agent: frozen.agent,
    i18n: frozen.i18n,
    earlyHints: frozen.earlyHints,
    extra,
  };
}

function importPath(fromDir: string, file: string): string {
  const p = relative(fromDir, file).split(sep).join("/").replace(/\.[^.]+$/, "");
  return p.startsWith(".") ? p : `./${p}`;
}

/** Read the app's tsconfig.json and return compilerOptions.jsxImportSource.
 *  Follows one level of `extends` so apps that inherit from a base tsconfig
 *  (e.g. "@kurajs/docs/tsconfig.kura.json") are handled correctly.
 *  Returns undefined when absent or unreadable. */
async function appJsxImportSource(appRoot: string): Promise<string | undefined> {
  type Tsconfig = { extends?: string; compilerOptions?: { jsxImportSource?: string } };
  const read = async (path: string): Promise<Tsconfig | undefined> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return undefined;
    try { return JSON.parse(await f.text()) as Tsconfig; } catch { return undefined; }
  };
  const tc = await read(join(appRoot, "tsconfig.json"));
  if (!tc) return undefined;
  if (tc.compilerOptions?.jsxImportSource) return tc.compilerOptions.jsxImportSource;
  // One level of extends: resolve relative paths and bare package specifiers.
  if (tc.extends) {
    const base = tc.extends.startsWith(".")
      ? join(appRoot, tc.extends)
      : join(appRoot, "node_modules", tc.extends);
    const btc = await read(base);
    if (btc?.compilerOptions?.jsxImportSource) return btc.compilerOptions.jsxImportSource;
  }
  return undefined;
}

export async function juneBuild(
  appRoot: string,
  options: { outDir?: string; external?: string[] } = {},
): Promise<BuildResult> {
  const appDir = join(appRoot, "app");
  if (!existsSync(appDir)) throw new Error(`no app/ directory in ${appRoot} — is this a June app?`);
  const genDir = join(appRoot, ".june");
  const outDir = options.outDir ?? join(appRoot, "dist");
  await mkdir(genDir, { recursive: true });
  await rm(outDir, { recursive: true, force: true }); // stale chunks must not ship

  const contentCollections = await generateContent(appRoot);
  const routes = (await scanRoutes(appDir)).sort((a, b) => a.path.localeCompare(b.path));
  if (routes.length === 0) throw new Error(`no page.* routes found under ${appDir}`);

  const frozen = await freezeConfig(appRoot);
  // The locales table freezes into the worker as data; a resolveLocale hook is a
  // function and won't survive JSON codegen. URL-pinned resolution + the built-in
  // negotiation chain still work in the worker — only the hook is dev-only for now.
  if (frozen.i18n?.resolveLocale) {
    console.warn(
      "[june build] i18n.resolveLocale is not yet wired into the built worker " +
        "(URL-pinned + built-in negotiation work; the hook runs in dev only).",
    );
  }
  // The deploy adapter packages the portable build for its target (default:
  // built-in workers()). It contributes the entry's export wrapper + emits the
  // deploy config.
  const fullConfig = await loadJuneConfig(appRoot);
  const adapter = (fullConfig.deploy?.adapter as JuneAdapter | undefined) ?? workers();

  // Fail fast on a config the target can't honor (e.g. Vercel has no D1) BEFORE
  // the expensive bundle/prerender. The adapter only needs to know which
  // resources are declared, so a presence-only plan suffices here.
  adapter.validate?.({
    plan: { db: fullConfig.resources?.db ? { binding: "DB", databaseName: "" } : undefined },
    config: fullConfig,
  });

  // Compile the global stylesheet ONCE and content-hash it: the built worker and
  // prerendered HTML link `/global.<hash>.css`, served immutable (cache forever,
  // a content change ships a new URL → no revalidation, no stale window). Dev
  // keeps the stable /global.css; only the asset HREF diverges dev↔built, never
  // render semantics. freezeConfig + buildManifest both default styles to the
  // stable URL — override both with the hashed one.
  const cssOut = await processCss(appDir, { minify: true });
  let cssAsset: string | null = null;
  if (cssOut !== null) {
    const hash = createHash("sha256").update(cssOut).digest("hex").slice(0, 8);
    cssAsset = `_june/global.${hash}.css`; // under the reserved /_june/ prefix
    frozen.document.styles = `/${cssAsset}`;
  }

  // CSS Modules: glob + transform app/**/*.module.css ONCE → the per-file class
  // maps (the bundlers + dev loaders look these up) AND the collected stylesheet,
  // which is content-hashed + emitted + linked just like global.css.
  const { maps: cssModuleMaps, css: rawModuleCss } = await buildModuleCss(appDir, appRoot);
  // Minify for build (dev serves it readable). Scoped class names are untouched,
  // so the hashed sheet still matches the maps the bundlers/loaders hand out.
  const moduleCss =
    rawModuleCss === null ? null : await minifyCss(rawModuleCss, "modules.css", await cssTargets(appDir));
  let moduleCssAsset: string | null = null;
  if (moduleCss !== null) {
    const hash = createHash("sha256").update(moduleCss).digest("hex").slice(0, 8);
    moduleCssAsset = `_june/modules.${hash}.css`;
    frozen.document.moduleStyles = `/${moduleCssAsset}`;
  }

  // Same for the client islands bundle: build + content-hash it NOW (before the
  // entry codegen + prerender) so both freeze the hashed /_june/client.<hash>.js
  // and it can be served immutable. The asset is written here. The client may
  // import .module.css too, so it gets the same module maps.
  const assetsDir = join(outDir, "assets");
  const clientEntry = findClientEntry(appDir);
  let clientAsset: string | null = null;
  if (clientEntry) {
    // Regenerate the auto lazy island registry before bundling (same as dev).
    generateIslandRegistry(appDir);
    clientAsset = await bundleClientToFile(clientEntry, appRoot, assetsDir, cssModuleMaps);
    frozen.document.clientScript = `/${clientAsset}`;
  }

  // Opt-in PER-ROUTE RSC build (page.rsc.tsx routes): emit the server + SSR-worker
  // graphs under <outDir>/rsc/. Gated on RSC routes existing, so apps without any
  // are byte-identical to before. Coexists with the SSR pipeline via a dispatcher.
  if (findRscRoutes(appDir).length > 0) {
    await buildRsc(appRoot, outDir, frozen.document);
  }

  // Declared resources become two things: a build-time plan (→ platform bindings
  // the adapter emits) and a runtime provider wired into the generated entry.
  // A resource-less app imports no config and emits no bindings, so its output
  // is byte-identical to before — the parity guarantee holds.
  const resourcesCfg = fullConfig.resources;
  const hasResources = !!(resourcesCfg?.db || resourcesCfg?.kv || resourcesCfg?.blob);

  // ---- generated entry -----------------------------------------------------
  // Routes are namespace-imported and adapted with routeFromModule, so the
  // multi-export page shape (default view + named loader/json/md) and the legacy
  // route({}) default export both work.
  const imports: string[] = [
    `import { createWorker } from "@junejs/server/worker";`,
    `import { routeFromModule } from "@junejs/core/route";`,
  ];
  const statics: string[] = [];
  const dynamics: string[] = [];
  const layoutIds = new Map<string, string>();
  const layoutId = (file: string) => {
    let id = layoutIds.get(file);
    if (!id) {
      id = `L${layoutIds.size}`;
      layoutIds.set(file, id);
      imports.push(`import ${id} from ${JSON.stringify(importPath(genDir, file))};`);
    }
    return id;
  };
  const loadingIds = new Map<string, string>();
  const loadingId = (file: string) => {
    let id = loadingIds.get(file);
    if (!id) {
      id = `Ld${loadingIds.size}`;
      loadingIds.set(file, id);
      imports.push(`import ${id} from ${JSON.stringify(importPath(genDir, file))};`);
    }
    return id;
  };
  // `segmentBoundary` is a STATIC export, so read each layout module here (no
  // render) to know its boundary flag AND whether it loads at all — codegen then
  // FILTERS null layouts and computes the boundary index/key through the SAME
  // shared resolver the dev/manifest paths use, so all three agree by
  // construction (not by a fragile "indices happen to line up" assumption).
  const layoutInfo = new Map<string, ImportedLayout | null>();
  for (const f of new Set(routes.flatMap((r) => (r.resource ? [] : r.layouts)))) {
    layoutInfo.set(f, await importLayout(f));
  }
  const chains: string[] = [];
  const boundaries: string[] = [];
  const loadings: string[] = [];
  const resources: string[] = [];
  routes.forEach((r, i) => {
    // Resource route (route.*): the default export IS the handler — import it
    // directly (no routeFromModule, no layout chain).
    if (r.resource) {
      imports.push(`import h${i} from ${JSON.stringify(importPath(genDir, r.file))};`);
      resources.push(`    { pattern: ${JSON.stringify(r.path)}, handler: h${i} },`);
      return;
    }
    imports.push(`import * as r${i} from ${JSON.stringify(importPath(genDir, r.file))};`);
    if (r.dynamic) dynamics.push(`    { pattern: ${JSON.stringify(r.path)}, def: routeFromModule(r${i}) },`);
    else statics.push(`    ${JSON.stringify(r.path)}: routeFromModule(r${i}),`);
    // entry = the emitted layout id (null layouts filtered out, so layoutId — and
    // its import — is only emitted for real layouts), matching the runtime chain.
    const { chain, boundaryIndex, key } = resolveBoundary(
      r.layouts.map((f) => {
        const info = layoutInfo.get(f) ?? null;
        return { file: f, entry: info ? layoutId(f) : null, boundary: !!info?.boundary };
      }),
    );
    chains.push(`    ${JSON.stringify(r.path)}: [${chain.join(", ")}],`);
    if (boundaryIndex !== null && key !== null) {
      boundaries.push(`    ${JSON.stringify(r.path)}: { index: ${boundaryIndex}, key: ${JSON.stringify(key)} },`);
    }
    if (r.loading) loadings.push(`    ${JSON.stringify(r.path)}: ${loadingId(r.loading)},`);
  });
  const resourceRoutesField = resources.length
    ? `\n  resourceRoutes: [\n${resources.join("\n")}\n  ],`
    : "";
  // Only emitted when some route declares a boundary, so boundary-less bundles
  // stay byte-identical (additive manifest field, like resources).
  const layoutBoundariesField = boundaries.length
    ? `\n  layoutBoundaries: {\n${boundaries.join("\n")}\n  },`
    : "";

  const builtExtraFile = findMiddlewareFile(appDir);
  if (builtExtraFile) {
    imports.push(`import extra from ${JSON.stringify(importPath(genDir, builtExtraFile))};`);
  }

  // The Link header is frozen here from the same builder the pipeline uses, so
  // the static and dynamic surfaces advertise identically. The adapter wraps the
  // portable pipeline for its target (workers() → withAssets).
  const linkHeader = buildLinkHeader(frozen.agent);
  const adapterEntry = adapter.entry({ linkHeader });

  // Resources (when declared) are bound from the worker's env (env.DB → D1) by
  // an env-aware provider. We bake a pure FLAGS descriptor — never importing the
  // user's config, which would drag the host-only sqlite()/dev server into the
  // workerd bundle. Only emitted when something is declared, so resource-less
  // bundles stay byte-identical (and host code never enters the graph).
  const resourceFlags = {
    db: !!resourcesCfg?.db,
    kv: !!resourcesCfg?.kv,
    blob: !!resourcesCfg?.blob,
  };
  // Two SQLite-dialect defaults, picked by the declared db's kind:
  //   turso()         → libsql over HTTPS, connected from env (TURSO_*) via the
  //                     bundled web client. Open the declared factory directly so it
  //                     feeds the ambient `import { db }` scope (re-emitted by kind,
  //                     not imported from the app config, to avoid the host barrel).
  //   sqlite()/d1()   → a D1 binding from env (env.DB), via bindWorkerResources.
  // (kv/blob on a turso deploy aren't wired yet — db-only.)
  const tursoDb = resourcesCfg?.db?.kind === "turso";
  if (tursoDb) {
    imports.push(`import { turso } from "@junejs/server/db";`);
    imports.push(`import { memoizeResources } from "@junejs/server/resources";`);
  } else if (hasResources) {
    imports.push(`import { bindWorkerResources } from "@junejs/server/resources";`);
  }
  const resourcesField = tursoDb
    ? `\n  resources: memoizeResources({ db: turso() }),`
    : hasResources
      ? `\n  resources: bindWorkerResources(${JSON.stringify(resourceFlags)}),`
      : "";

  // Opt-in Tier-3 data layer: import its installDataLayer from the declared module
  // and call it at worker boot — the prod twin of the dev host's dataLayer.install()
  // (createApp). The user's config names the module; the framework never hard-codes it.
  const dataLayerModule = fullConfig.dataLayer?.module;
  if (dataLayerModule) {
    imports.push(`import { installDataLayer } from ${JSON.stringify(dataLayerModule)};`);
  }
  const dataLayerBoot = dataLayerModule ? "\ninstallDataLayer();\n" : "";

  const entry = `// AUTO-GENERATED by \`june build\` — do not edit. Regenerate: june build .
${adapterEntry.imports.join("\n")}
${imports.join("\n")}
${dataLayerBoot}
const pipeline = createWorker({
  routes: {
${statics.join("\n")}
  },
  dynamicRoutes: [
${dynamics.join("\n")}
  ],${resourceRoutesField}
  layoutChains: {
${chains.join("\n")}
  },${layoutBoundariesField}
  loadings: {
${loadings.join("\n")}
  },
  document: ${JSON.stringify(frozen.document, null, 2).replace(/\n/g, "\n  ")},
  agent: ${JSON.stringify(frozen.agent)},${frozen.i18n ? `\n  i18n: ${JSON.stringify(frozen.i18n)},` : ""}
  earlyHints: ${JSON.stringify(frozen.earlyHints)},${builtExtraFile ? "\n  extra," : ""}${resourcesField}
});

${adapterEntry.wrap("pipeline")}
`;
  const entryFile = join(genDir, "worker-entry.tsx");
  await writeFile(entryFile, entry);

  // ---- bundle (Rolldown; self-contained ESM for workerd) -------------------
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: entryFile,
    cwd: appRoot,
    platform: "browser", // workerd's surface is web-standard; no node:* in the graph
    // Bake NODE_ENV=production at BUILD (the same the client bundle does), so React's
    // server entry folds to its production build (smaller/faster, no dev warnings) and
    // the dev-only code tree-shakes. Build-time on purpose: runtime process.env.NODE_ENV
    // differs by target (Vercel sets it; workerd may not), so baking it makes the output
    // deterministic and target-agnostic. `june dev` doesn't use this path.
    transform: {
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      // Route JSX through June's runtime so `<X client:*/>` in pages emits island
      // markers at SSR. Rolldown ignores tsconfig/pragma so we must set importSource
      // explicitly — BUT only when the app's tsconfig doesn't already declare it as
      // "@junejs/core". When both are set to the same value rolldown emits
      // CONFIGURATION_FIELD_CONFLICT (value-independent); skip the explicit set so
      // rolldown reads it from tsconfig silently.
      jsx: {
        runtime: "automatic",
        ...((await appJsxImportSource(appRoot)) === "@junejs/core"
          ? {}
          : { importSource: "@junejs/core" }),
      },
    },
    plugins: [rolldownCssModulesPlugin(cssModuleMaps)], // .module.css → scoped class map
    external: (id: string) => {
      // Bun built-ins exist only at Bun runtime, never in the workerd graph (see isBunSpecifier).
      if (isBunSpecifier(id)) return true;
      // Binary assets stay external — wrangler's CompiledWasm/Data rules own them.
      if (/\.(wasm|ttf|otf|woff2?|png|jpe?g|avif|webp)$/.test(id)) return true;
      // Merge: adapter.buildExternal (target-specific, e.g. workers-og for the
      // Workers adapter) + config build.external (user additions). User config
      // wins additions but can never REMOVE the adapter's own required externals.
      const list = [
        ...(adapter.buildExternal ?? []),
        ...(options.external ?? frozen.buildExternal),
      ];
      return list.some((e) => id === e || id.startsWith(`${e}/`));
    },
    resolve: {
      // Conditions BAKED at build (the target has no runtime conditions, reminder
      // #3). Adapter-owned: workers → workerd, vercel → edge-light.
      conditionNames: adapter.conditions,
    },
  });
  const result = await bundle.write({ dir: outDir, format: "esm", entryFileNames: "worker.js" });
  await bundle.close();
  const outFile = join(
    outDir,
    result.output.find((o) => o.type === "chunk" && o.isEntry)?.fileName ?? "worker.js",
  );

  // ---- prerender: opted-in static routes render THROUGH the worker ---------
  // Same render path as the bundle (createWorker over the frozen manifest), so
  // what ships is what the parity test verified.
  const prerendered: string[] = [];
  // Prerender imports route modules in-process, so the runtime CSS-Modules
  // interceptor must be active for any route that imports a .module.css.
  await registerCssModules(cssModuleMaps);
  const manifest = await buildManifest(appRoot);
  if (cssAsset) manifest.document.styles = `/${cssAsset}`; // prerendered HTML links the hashed sheet
  if (clientAsset) manifest.document.clientScript = `/${clientAsset}`;
  if (moduleCssAsset) manifest.document.moduleStyles = `/${moduleCssAsset}`;
  const worker = createWorker(manifest);
  let hasAssets = false;

  for (const r of routes.filter((x) => !x.dynamic)) {
    const def = manifest.routes[r.path];
    if (!def || !def.prerender) continue;
    const stem = r.path === "/" ? "index" : r.path.slice(1);
    // The homepage's projection requests are `/index.md` / `/index.json` (negotiate
    // treats `/index` as the alias for `/`); these become the `index.md` /
    // `index.json` assets the worker serves at the same intuitive paths.
    const mdReq = r.path === "/" ? "/index.md" : `${r.path}.md`;
    const jsonReq = r.path === "/" ? "/index.json" : `${r.path}.json`;
    const targets: Array<[string, string]> = [
      [r.path, `${stem}.html`],
      [mdReq, `${stem}.md`],
    ];
    if (typeof def.json === "function") targets.push([jsonReq, `${stem}.json`]);
    for (const [reqPath, file] of targets) {
      const res = await worker.fetch(new Request(`https://prerender.june${reqPath}`));
      if (!res.ok) throw new Error(`prerender ${reqPath} → ${res.status}`);
      const dest = join(assetsDir, file);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    }
    prerendered.push(r.path);
    hasAssets = true;
  }

  // ---- client islands bundle: built + content-hashed earlier (assets/_june/
  //      client.<hash>.js, frozen into the document). No entry → page ships zero JS.
  if (clientAsset) hasAssets = true;

  // ---- global stylesheet: app/global.css → assets/global.css ---------------
  // Served at /global.css; the frozen document already <link>s it. Compiled
  // (Tailwind) or passed through (plain CSS). No file → no asset.
  if (cssOut !== null && cssAsset) {
    const dest = join(assetsDir, cssAsset);
    await mkdir(dirname(dest), { recursive: true }); // cssAsset includes the _june/ subdir
    await writeFile(dest, cssOut);
    hasAssets = true;
  }

  // ---- collected CSS Modules: app/**/*.module.css → assets/_june/modules.<hash>.css
  if (moduleCss !== null && moduleCssAsset) {
    const dest = join(assetsDir, moduleCssAsset);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, moduleCss);
    hasAssets = true;
  }

  // ---- deploy structure (adapter-owned: wrangler.jsonc for workers) --------
  const pkgPath = join(appRoot, "package.json");
  const pkgName = existsSync(pkgPath)
    ? (JSON.parse(await Bun.file(pkgPath).text()) as { name?: string }).name
    : undefined;
  const defaultName = (pkgName ?? basename(appRoot)).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  // A declared D1-backed db (sqlite/d1) → a D1 binding named DB (the name
  // bindWorkerResources reads). turso() connects from env, not a binding — no plan.
  const plan: ResourcePlan =
    resourcesCfg?.db && resourcesCfg.db.kind !== "turso"
      ? { db: { binding: "DB", databaseName: `${defaultName}-db` } }
      : {};
  await adapter.emit({ appRoot, outDir, hasAssets, linkHeader, config: fullConfig, plan, defaultName });
  if (plan.db) {
    console.log(
      `  ↳ d1 binding "${plan.db.binding}" emitted — set database_id in wrangler.jsonc (wrangler d1 create ${plan.db.databaseName})`,
    );
  }

  return {
    outFile,
    routes: routes.filter((r) => !r.dynamic).map((r) => r.path),
    dynamicRoutes: routes.filter((r) => r.dynamic).map((r) => r.path),
    contentCollections,
    prerendered,
  };
}
