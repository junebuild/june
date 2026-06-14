// CSS Modules — `import styles from "./X.module.css"` gives a map of local class
// names → scoped names, and the scoped CSS is collected into one stylesheet.
//
// The hard constraint: the scoped names must be byte-identical in dev SSR
// (un-bundled import), the worker build, and the client build (hydration must
// match SSR). We guarantee that by NEVER deriving the name from a bundler
// internal — `scopedName(stableKey, class)` is a pure hash of an app-relative
// path + the class. One main-thread pass globs + transforms every .module.css
// into a maps dict; the Bun plugin / Node loader / rolldown plugin are then dumb
// lookups into it, and the served/emitted CSS comes from the SAME pass — so the
// JS maps and the CSS agree by construction.
//
// Transforms go through postcss-modules, so the full CSS-Modules surface works:
// local scoping (the default), `:global(...)`, and cross-file `composes`. The one
// thing we override is generateScopedName — it's our deterministic hash, not a
// bundler internal, which is what makes dev/build/client/Node agree.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AcceptedPlugin } from "postcss";

export const MODULE_STYLES_URL = "/_june/modules.css";

export const isModuleCss = (id: string) => id.endsWith(".module.css");

// App-relative POSIX path — the stable scoping key (machine/cwd independent).
export function stableKey(appRoot: string, file: string): string {
  return relative(appRoot, file).split(sep).join("/");
}

function scopedName(key: string, cls: string): string {
  const h = createHash("sha256").update(`${key}|${cls}`).digest("hex").slice(0, 8);
  return `${cls}_${h}`;
}

// Transform one .module.css via postcss-modules — correct scoping, `:global`,
// `composes` (cross-file), and url()/string safety — but with OUR deterministic
// generateScopedName, so dev SSR / worker build / client build / Node all produce
// identical names. postcss is imported lazily and only runs at build/dev time, so
// it never enters the worker graph.
export async function transformCssModule(
  file: string,
  appRoot: string,
): Promise<{ map: Record<string, string>; css: string }> {
  const postcss = (await import("postcss")).default;
  const postcssModules = (await import("postcss-modules")).default as (opts: {
    generateScopedName(name: string, filename: string): string;
    getJSON(file: string, json: Record<string, string>): void;
  }) => AcceptedPlugin;
  let map: Record<string, string> = {};
  const result = await postcss([
    postcssModules({
      generateScopedName: (name, filename) => scopedName(stableKey(appRoot, filename), name),
      getJSON: (_f, json) => {
        map = json;
      },
    }),
  ]).process(await readFile(file, "utf8"), { from: file });
  return { map, css: result.css };
}

// The JS a .module.css import resolves to.
export const moduleJs = (map: Record<string, string>): string =>
  `export default ${JSON.stringify(map)};`;

export type ModuleMaps = Record<string, Record<string, string>>; // absPath → class map

async function findModuleCss(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".module.css")) out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

// One pass over app/**/*.module.css → the per-file class maps AND the combined
// scoped stylesheet. null css when there are none. Deterministic, so the maps the
// loaders hand out match the CSS that's served/emitted.
export async function buildModuleCss(
  appDir: string,
  appRoot: string,
): Promise<{ maps: ModuleMaps; css: string | null }> {
  const files = await findModuleCss(appDir);
  const maps: ModuleMaps = {};
  const parts: string[] = [];
  for (const file of files) {
    const { map, css } = await transformCssModule(file, appRoot);
    maps[file] = map;
    parts.push(css);
  }
  return { maps, css: parts.length ? parts.join("\n") : null };
}

// --- the three dumb interception points (all lookups into `maps`) ------------

// BUILD: a rolldown plugin. rolldown removed CSS support and infers type from
// the .css extension, so `moduleType: "js"` forces it to treat our map as JS.
// Added to BOTH the worker bundle and the client bundle.
export function rolldownCssModulesPlugin(maps: ModuleMaps): {
  name: string;
  load(id: string): { code: string; moduleType: "js" } | null;
} {
  return {
    name: "june-css-modules",
    load(id) {
      if (!isModuleCss(id)) return null;
      return { code: moduleJs(maps[id] ?? {}), moduleType: "js" };
    },
  };
}

// RUNTIME (in-process imports — dev SSR + build prerender): register an
// interceptor so `import "x.module.css"` returns the scoped map. The maps are a
// module-level reference the Bun plugin reads LIVE (one process can serve several
// apps across tests/build); the Node loader gets a snapshot at register time.
let activeMaps: ModuleMaps = {};
let runtimeRegistered = false;

function registerBunCssModules(): void {
  const B = (globalThis as { Bun?: { plugin(p: unknown): void } }).Bun!;
  B.plugin({
    name: "june-css-modules",
    setup(build: { onLoad(opts: { filter: RegExp }, cb: (a: { path: string }) => unknown): void }) {
      build.onLoad({ filter: /\.module\.css$/ }, (args) => ({
        loader: "js",
        contents: moduleJs(activeMaps[args.path] ?? {}),
      }));
    },
  });
}

async function registerNodeCssModules(maps: ModuleMaps): Promise<void> {
  const { register } = await import("node:module");
  register(new URL("./css-modules-loader.mjs", import.meta.url), { data: { maps } });
}

// Point the runtime interceptor at THIS app's maps (and register it once, the
// first time there's anything to intercept). No-op until an app has module CSS.
export async function registerCssModules(maps: ModuleMaps): Promise<void> {
  activeMaps = maps;
  if (runtimeRegistered || !Object.keys(maps).length) return;
  runtimeRegistered = true;
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") registerBunCssModules();
  else await registerNodeCssModules(maps);
}
