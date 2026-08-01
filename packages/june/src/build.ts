// `june build` — produce a Workers-ready bundle from a June app.
//
// What the dev server discovers at REQUEST time (filesystem routes,
// june.config.ts, content/ markdown), the build discovers ONCE and FREEZES into
// a static manifest fed to createWorker(). The built worker renders through the
// SAME pipeline as dev (pipeline.ts), so its surfaces are byte-equivalent —
// proven by test/parity.test.ts, not hoped for.
//
// The build's separable stages live in sibling modules (re-exported here so
// consumers keep one import root):
//   route-scan.ts     — app/ + .june/routes/ discovery and merge (scanAppRoutes)
//   content-freeze.ts — content/ → app/_content.ts (generateContent)
//   config-freeze.ts  — june.config.ts → serializable worker bits (freezeConfig)
//   manifest.ts       — the in-process freeze (buildManifest; parity + prerender)
// This file keeps the full-build orchestration: juneBuild = content freeze +
// generated entry + Rolldown bundle (workerd conditions, binary externals) +
// prerender-through-the-worker + wrangler config.
//
// REMINDER #4: nothing in the worker graph may statically import node:*. The
// content freeze (content/*.md → app/_content.ts) is what removes fs from the
// dynamic route's graph; the worker reads frozen data, never the filesystem.

import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { loadJuneConfig } from "./config-loader";
import { buildLinkHeader } from "@junejs/core/discovery";
import { localeHref } from "@junejs/core/i18n";
import type { BrandedRoute } from "@junejs/core/route";
import type { ResourcePlan } from "./adapter";
import { generateAgentModule } from "./agent-compile";
import { freezeConfig, resolveDeployAdapter, workerName } from "./config-freeze";
import { generateContent } from "./content-freeze";
import { createWorker } from "./worker";
import { buildManifest, importLayout, type ImportedLayout } from "./manifest";
import { findMiddlewareFile } from "./router";
import { scanAppRoutes } from "./route-scan";
import { resolveBoundary } from "./segment";
import { findClientEntry, bundleClientToFile } from "./client-bundle";
import { RESERVED_PREFIX } from "./static-files";
import { jsxTransform } from "./tsconfig-jsx";
import { generateIslandRegistry } from "./island-registry";
import { buildRsc, findRscRoutes } from "./rsc-build";
import { cssTargets, minifyCss, processCss } from "./css";
import { buildModuleCss, rolldownCssModulesPlugin, registerCssModules } from "./css-modules";

export { scanRoutes, scanAppRoutes, type RouteEntry } from "./route-scan";
export { generateContent } from "./content-freeze";
export { freezeConfig, normalizeBase, resolveDeployAdapter, workerName } from "./config-freeze";
export { buildManifest } from "./manifest";

export type BuildResult = {
  outFile: string;
  routes: string[];
  dynamicRoutes: string[];
  contentCollections: string[];
  prerendered: string[];
};

// Bun built-ins (`bun`, `bun:sqlite`, …) exist only at the Bun runtime and must never enter the
// workerd graph. Marking them external keeps rolldown from constant-folding the `const x = "bun";
// import(x)` runtime guard (in @junejs/core's cache.ts) and warning UNRESOLVED_IMPORT. Exported so
// the build keeps externalizing them — see test/build-externals.test.ts.
export const isBunSpecifier = (id: string): boolean => id === "bun" || id.startsWith("bun:");

function importPath(fromDir: string, file: string): string {
  const p = relative(fromDir, file).split(sep).join("/").replace(/\.[^.]+$/, "");
  return p.startsWith(".") ? p : `./${p}`;
}

// Recursively list every file under `dir` as a forward-slash relative path. Used
// to enumerate public/ for the verbatim asset copy (dot-files included — a
// `.well-known/` under public/ is a legitimate thing to ship).
async function collectFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(abs, base)));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
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
  // Same merge as buildManifest: app/ takes priority over .june/routes/.
  const routes = await scanAppRoutes(appRoot);
  if (routes.length === 0) throw new Error(`no page.* routes found under ${appDir} or .june/routes/`);

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
  const adapter = resolveDeployAdapter(fullConfig.deploy);

  // Fail fast on a config the target can't honor (e.g. Vercel has no D1) BEFORE
  // the expensive bundle/prerender. The adapter only needs to know which
  // resources are declared, so a presence-only plan suffices here.
  adapter.validate?.({
    plan: { db: fullConfig.resources?.db ? { binding: "DB", databaseName: "" } : undefined },
    config: fullConfig,
  });

  // ---- durable agent (the F7 mount): compile app/agent → _agent.gen.ts ------
  // The generated entry mounts the compiled module statically (fs discovery
  // can't run on workerd) and exports the per-session Durable Object class.
  // Only a target with Durable Objects can host the session actor — elsewhere
  // the agent surface is skipped with a notice, and an app without an agent/
  // directory emits a byte-identical entry (the parity guarantee).
  const agentDir = join(appDir, frozen.agent.runtime.dir);
  let agentModule: { file: string } | null = null;
  if (frozen.agent.runtime.enabled) {
    const generated = generateAgentModule(agentDir);
    if (generated && adapter.capabilities.durableObjects) {
      agentModule = generated;
    } else if (generated) {
      console.warn(
        `[june build] app/${frozen.agent.runtime.dir}/ found, but the ${adapter.name}() target has no Durable Objects — the durable agent is not mounted.`,
      );
    }
  }
  if (agentModule) {
    // The generated DO's model is Claude, and workerd has no runtime module
    // resolution — the SDK must be a real dependency of the app so the entry's
    // STATIC import bundles it (@junejs/core treats it as an optional peer; the
    // adapter's own lazy import can never be bundled). Fail the build with the
    // fix, never ship a worker whose first model turn dies on a bare import.
    // An explicit node_modules walk, not a resolver API: the check must behave
    // identically on every host (Bun.resolveSync missed a symlinked scoped
    // package on Linux CI that it found on macOS), and Rolldown does its own
    // resolution at bundle time anyway — this is a preflight, not the resolver.
    const sdkResolvable = (fromDir: string): boolean => {
      // Absolute first: with a relative root (juneBuild(".")), dirname(".") is
      // still "." and the walk would stop before reaching a hoisted parent.
      for (let d = resolve(fromDir); ; ) {
        if (existsSync(join(d, "node_modules", "@anthropic-ai", "sdk", "package.json"))) return true;
        const parent = dirname(d);
        if (parent === d) return false;
        d = parent;
      }
    };
    if (!sdkResolvable(appRoot)) {
      throw new Error(
        `app/${frozen.agent.runtime.dir}/ mounts a durable agent whose model is Claude — ` +
          `add the SDK to the app so it bundles for workerd: bun add @anthropic-ai/sdk`,
      );
    }
  }

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
  const clientEntry =
    findClientEntry(appDir) ?? findClientEntry(join(appRoot, ".june", "routes"));
  let clientAsset: string | null = null;
  if (clientEntry) {
    // Regenerate the auto lazy island registry before bundling (same as dev).
    await generateIslandRegistry(appDir);
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
  // One expression, TWO instances: the pipeline (createWorker) and the durable
  // agent's DO each open their own provider — the DO is a separate isolate whose
  // env must not be captured by the worker-side memoization.
  const resourcesExpr = tursoDb
    ? `memoizeResources({ db: turso() })`
    : hasResources
      ? `bindWorkerResources(${JSON.stringify(resourceFlags)})`
      : null;
  const resourcesField = resourcesExpr ? `\n  resources: ${resourcesExpr},` : "";

  // Opt-in Tier-3 data layer: import its installDataLayer from the declared module
  // and call it at worker boot — the prod twin of the dev host's dataLayer.install()
  // (createApp). The user's config names the module; the framework never hard-codes it.
  const dataLayerModule = fullConfig.dataLayer?.module;
  if (dataLayerModule) {
    imports.push(`import { installDataLayer } from ${JSON.stringify(dataLayerModule)};`);
  }
  const dataLayerBoot = dataLayerModule ? "\ninstallDataLayer();\n" : "";

  // App services: import the app's `(env) => services` factory (the named `services`
  // export of the declared module) into the entry and hand it to createWorker, which
  // binds it from the worker env per request — the prod twin of app.ts building it from
  // process.env. Like resources, the module (not the config) is imported, so the config's
  // host-only bits never enter the worker graph. Emitted only when declared.
  //
  // The specifier is rebased like a route import: an app-relative path (`./app/services.ts`)
  // is resolved against appRoot then made relative to the entry's dir (.june), since the
  // generated entry lives there; a bare specifier (a shared package, like dataLayer.module)
  // is used verbatim.
  const servicesModule = fullConfig.services?.module;
  if (servicesModule) {
    const spec = /^[./]/.test(servicesModule) ? importPath(genDir, resolve(appRoot, servicesModule)) : servicesModule;
    imports.push(`import { services as __appServices } from ${JSON.stringify(spec)};`);
  }
  const servicesField = servicesModule ? `\n  services: __appServices,` : "";

  // Durable agent: import the compiled agent module + the DO shell pieces, set
  // agentName on the manifest (what activates createWorker's chat routing), and
  // export the DO class the adapter's wrangler binding names. cloudflare:workers
  // is a workerd runtime module — external to the bundle (see the predicate below).
  if (agentModule) {
    imports.push(`import __agentModule from ${JSON.stringify(importPath(genDir, agentModule.file))};`);
    imports.push(`import { assembleDurable } from "@junejs/core/agent-config";`);
    imports.push(`import { anthropic } from "@junejs/core/agent-models";`);
    imports.push(`import { AgentDurableObject } from "@junejs/server/agent-durable";`);
    imports.push(`import { DurableObject } from "cloudflare:workers";`);
    // STATIC so Rolldown bundles the SDK (the adapter's own import is a
    // non-literal lazy specifier — deliberately unbundleable); injected via
    // anthropic({ client }), which skips that lazy path entirely.
    imports.push(`import Anthropic from "@anthropic-ai/sdk";`);
  }
  // Assembled BEFORE createWorker: the manifest consumes the channels (worker-
  // side webhook routing) and the DO class consumes the full definition.
  const agentPreamble = agentModule ? `\nconst __agentDef = assembleDurable(__agentModule);\n` : "";
  const agentNameField = agentModule ? `\n  agentName: __agentModule.config.name,\n  agentChannels: __agentDef.channels,` : "";
  const doClass = agentModule
    ? `
// The durable agent: one Durable Object per session, the compiled agent/
// directory as its definition — adapted tools (+ read_skill when skills exist),
// the assembled system prompt, channel factories resolved with the DO's own
// env, and the app's declared resources opened from THIS isolate's env (lazily,
// at the first turn — the same ambient db a tool sees in native dev). Model:
// Anthropic over a statically bundled client (workerd cannot resolve a bare
// import at runtime), keyed by the ANTHROPIC_API_KEY secret — a missing secret
// surfaces as the SDK's own clear construction error on the first agent request.
export class JuneAgentDO extends DurableObject {
  #agent = new AgentDurableObject(this.ctx, {
    ...__agentDef,
    model: anthropic({ model: __agentModule.config.model, client: new Anthropic({ apiKey: (this.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY }) }),
    env: this.env,${resourcesExpr ? `\n    resources: ${resourcesExpr},` : ""}${servicesModule ? "\n    services: __appServices(this.env)," : ""}
  });
  fetch(req: Request): Promise<Response> {
    return this.#agent.fetch(req);
  }
}
`
    : "";

  const entry = `// AUTO-GENERATED by \`june build\` — do not edit. Regenerate: june build .
${adapterEntry.imports.join("\n")}
${imports.join("\n")}
${dataLayerBoot}${agentPreamble}
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
  agent: ${JSON.stringify(frozen.agent)},${agentNameField}${frozen.i18n ? `\n  i18n: ${JSON.stringify(frozen.i18n)},` : ""}
  earlyHints: ${JSON.stringify(frozen.earlyHints)},${builtExtraFile ? "\n  extra," : ""}${resourcesField}${servicesField}
});

${adapterEntry.wrap("pipeline")}
${doClass}`;
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
      // markers at SSR — via the shared jsxTransform, which skips the explicit
      // importSource when the app's tsconfig already declares it (else rolldown
      // emits CONFIGURATION_FIELD_CONFLICT, value-independent). See tsconfig-jsx.ts.
      jsx: await jsxTransform(appRoot),
    },
    plugins: [rolldownCssModulesPlugin(cssModuleMaps)], // .module.css → scoped class map
    external: (id: string) => {
      // Bun built-ins exist only at Bun runtime, never in the workerd graph (see isBunSpecifier).
      if (isBunSpecifier(id)) return true;
      // workerd runtime modules (the durable-agent entry imports cloudflare:workers).
      if (id.startsWith("cloudflare:")) return true;
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

  // ---- public/ → assets/ : verbatim static files (favicon, images, fonts) ----
  // Copied here, BEFORE the framework's hashed assets are written below, so a
  // stray public/_june/* can never overwrite the real client bundle / CSS (it is
  // skipped outright). Passthrough only — no hashing/optimization. `publicFiles`
  // is the relative-path list adapters need to place these on their static tier.
  const publicDir = join(appRoot, "public");
  const publicFiles: string[] = [];
  // Only a REAL directory: a symlinked public/ (e.g. `public -> ..`) would copy
  // files from OUTSIDE the app root into the deploy output. collectFiles already
  // drops symlinked entries UNDER public/ (Dirent.isFile()/isDirectory()); this
  // guards the root itself. lstatSync doesn't follow the symlink, so a symlinked
  // public/ has isDirectory() === false.
  let publicIsDir = false;
  try {
    publicIsDir = lstatSync(publicDir).isDirectory();
  } catch {
    /* no public/ */
  }
  if (existsSync(publicDir) && !publicIsDir) {
    console.warn(`[june] public/ is not a real directory (symlink?) — skipped`);
  }
  if (publicIsDir) {
    for (const rel of await collectFiles(publicDir)) {
      if (rel.split("/")[0] === RESERVED_PREFIX) {
        console.warn(`[june] public/${rel} ignored — ${RESERVED_PREFIX}/ is reserved for framework assets`);
        continue;
      }
      const dest = join(assetsDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(publicDir, ...rel.split("/")), dest);
      publicFiles.push(rel);
    }
    if (publicFiles.length) hasAssets = true;
  }

  // static() target: prerender EVERY route (not just opted-in ones) + enumerate
  // dynamic routes via their staticPaths, and write <stem>/index.html so clean URLs
  // resolve on a dumb file host with no rewrite server. Other targets keep the
  // opt-in `prerender: true` behavior and the flat <stem>.html naming (byte-identical).
  const isStatic = adapter.capabilities.runtime === "static";
  const i18n = frozen.i18n;

  // Render ONE route pathname through the worker → HTML (+ .md/.json projections).
  const prerenderOne = async (reqPath: string, def: BrandedRoute): Promise<void> => {
    const stem = reqPath === "/" ? "index" : reqPath.slice(1);
    // static → <stem>/index.html (dir-style, clean subpath URL); else flat <stem>.html.
    const htmlFile = isStatic ? (reqPath === "/" ? "index.html" : `${stem}/index.html`) : `${stem}.html`;
    // The homepage's projection requests are `/index.md` / `/index.json` (negotiate
    // treats `/index` as the alias for `/`); these become the `index.md` /
    // `index.json` assets the worker serves at the same intuitive paths. A LOCALE
    // home ("/zh-cn") needs the same treatment: "/zh-cn.md" has no "/" boundary, so
    // the locale matcher can't strip the prefix and it routes as a phantom slug —
    // request "/zh-cn/index.md" (prefix strips to "/index.md") and emit
    // "zh-cn/index.md", mirroring the root home exactly.
    const isHome = reqPath === "/" ||
      (i18n != null && Object.keys(i18n.locales).some((l) => localeHref(i18n, "/", l) === reqPath));
    const mdReq = reqPath === "/" ? "/index.md" : isHome ? `${reqPath}/index.md` : `${reqPath}.md`;
    const jsonReq = reqPath === "/" ? "/index.json" : isHome ? `${reqPath}/index.json` : `${reqPath}.json`;
    const mdFile = reqPath === "/" ? "index.md" : isHome ? `${stem}/index.md` : `${stem}.md`;
    const jsonFile = reqPath === "/" ? "index.json" : isHome ? `${stem}/index.json` : `${stem}.json`;
    const targets: Array<[string, string]> = [[reqPath, htmlFile]];
    if (def.md !== false) targets.push([mdReq, mdFile]); // .md/.json stay flat (exact-path negotiation)
    if (typeof def.json === "function") targets.push([jsonReq, jsonFile]);
    for (const [rp, file] of targets) {
      const res = await worker.fetch(new Request(`https://prerender.june${rp}`));
      if (!res.ok) throw new Error(`prerender ${rp} → ${res.status}`);
      const dest = join(assetsDir, file);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    }
    prerendered.push(reqPath);
    hasAssets = true;
  };

  // Locale variants a static route is emitted at: no i18n → [path]; with i18n → one
  // per locale (defaultLocale keeps the bare path, others get their localeHref prefix).
  const localeVariants = (path: string): string[] =>
    isStatic && i18n
      ? [...new Set(Object.keys(i18n.locales).map((l) => localeHref(i18n, path, l)))]
      : [path];

  for (const r of routes.filter((x) => !x.dynamic)) {
    const def = manifest.routes[r.path];
    if (!def) continue;
    if (!isStatic && !def.prerender) continue; // other targets: opt-in only (unchanged)
    for (const p of localeVariants(r.path)) await prerenderOne(p, def);
  }

  if (isStatic) {
    // Dynamic routes freeze to files only when they enumerate their pages: a
    // `staticPaths` export lists concrete pathnames (locale prefixes already applied
    // by the producer — Kura hands over every locale × slug for the docs catch-all).
    for (const dyn of manifest.dynamicRoutes ?? []) {
      const sp = dyn.def.staticPaths;
      if (!sp) continue;
      const paths = typeof sp === "function" ? await sp() : sp;
      for (const p of paths) await prerenderOne(p, dyn.def);
    }
    // Framework surfaces the worker would otherwise generate on the fly. Guarded on
    // res.ok so a disabled agent (no llms.txt/sitemap) or a custom favicon simply
    // skips its file rather than failing the build.
    const extra: Array<[string, string]> = [
      ["/favicon.svg", "favicon.svg"],
      ["/llms.txt", "llms.txt"],
      ["/sitemap.xml", "sitemap.xml"],
    ];
    for (const [reqPath, file] of extra) {
      const res = await worker.fetch(new Request(`https://prerender.june${reqPath}`));
      if (!res.ok) continue;
      await writeFile(join(assetsDir, file), Buffer.from(await res.arrayBuffer()));
      hasAssets = true;
    }
    // 404.html — GitHub Pages serves it for any unmatched URL. A deliberately-missing
    // path renders June's not-found HTML (body is written regardless of the 404 status).
    const nf = await worker.fetch(new Request("https://prerender.june/__june_not_found__"));
    await writeFile(join(assetsDir, "404.html"), Buffer.from(await nf.arrayBuffer()));
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
  const defaultName = workerName(pkgName ?? basename(appRoot));
  // A declared D1-backed db (sqlite/d1) → a D1 binding named DB (the name
  // bindWorkerResources reads). turso() connects from env, not a binding — no plan.
  const plan: ResourcePlan = {
    ...(resourcesCfg?.db && resourcesCfg.db.kind !== "turso"
      ? { db: { binding: "DB", databaseName: `${defaultName}-db` } }
      : {}),
    // The durable agent's DO binding — the name createWorker reads (env.AGENT)
    // and the class the generated entry exports.
    ...(agentModule ? { agent: { binding: "AGENT", className: "JuneAgentDO" } } : {}),
  };
  await adapter.emit({ appRoot, outDir, hasAssets, linkHeader, config: fullConfig, plan, defaultName, publicFiles });
  if (plan.db) {
    console.log(
      `  ↳ d1 binding "${plan.db.binding}" emitted — set database_id in wrangler.jsonc (wrangler d1 create ${plan.db.databaseName})`,
    );
  }
  if (plan.agent) {
    console.log(`  ↳ durable agent mounted (${plan.agent.className} → env.${plan.agent.binding}; chat at ${frozen.agent.runtime.chat.path})`);
  }

  return {
    outFile,
    routes: routes.filter((r) => !r.dynamic).map((r) => r.path),
    dynamicRoutes: routes.filter((r) => r.dynamic).map((r) => r.path),
    contentCollections,
    prerendered,
  };
}
