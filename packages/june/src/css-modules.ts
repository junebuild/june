// CSS Modules — `import styles from "./X.module.css"` gives a map of local class
// names → scoped names, and the scoped CSS is collected into one stylesheet.
//
// The hard constraint: the scoped names must be byte-identical in dev SSR
// (un-bundled import), the worker build, and the client build (hydration must
// match SSR). One main-thread pass globs + transforms every .module.css into a
// maps dict; the Bun plugin / Node loader / rolldown plugin are then dumb lookups
// into it, and the served/emitted CSS comes from the SAME pass — so the JS maps
// and the CSS agree by construction. Names stay machine-independent because the
// transform is keyed on an APP-RELATIVE path (stableKey), not an absolute one.
//
// Engine: Lightning CSS (Rust) — local scoping (default), `:global(...)`, and
// cross-file `composes`. Unlike postcss-modules, Lightning resolves `composes` by
// REFERENCE (it records the composed scoped name; it does NOT inline the rule), so
// a class composed across N files lands ONCE in the sheet with no dedup pass.
// Lightning is imported lazily and only runs at build/dev time, so it never enters
// the worker graph.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";

export const MODULE_STYLES_URL = "/_june/modules.css";

export const isModuleCss = (id: string) => id.endsWith(".module.css");

// App-relative POSIX path — the stable scoping key (machine/cwd independent).
export function stableKey(appRoot: string, file: string): string {
  return relative(appRoot, file).split(sep).join("/");
}

// One `composes` entry, as Lightning reports it: a class in this file (local, already
// scoped), a global class (unscoped, applied as-is), or a class in another module
// file (dependency — resolved against that file's exports).
type Compose =
  | { type: "local"; name: string }
  | { type: "global"; name: string }
  | { type: "dependency"; name: string; specifier: string };
type ModuleExports = Record<string, { name: string; composes: Compose[] }>;
type Transformed = { css: string; exports: ModuleExports };

// Lightning-transform ONE file: deterministic scoped CSS + its exports. Cross-file
// `composes` come back as unresolved `dependency` refs — the caller resolves them.
async function transformOne(file: string, appRoot: string): Promise<Transformed> {
  const { transform } = await import("lightningcss");
  const { code, exports } = transform({
    // The STABLE app-relative path drives Lightning's [hash], so names are
    // machine-independent and identical across dev / worker build / client build.
    filename: stableKey(appRoot, file),
    code: Buffer.from(await readFile(file, "utf8")),
    cssModules: { pattern: "[local]_[hash]" },
  });
  return { css: code.toString(), exports: (exports ?? {}) as ModuleExports };
}

// Transform `entry` and (recursively) every file it composes from, into `all`.
async function transformGraph(
  entry: string,
  appRoot: string,
  all: Record<string, Transformed> = {},
): Promise<Record<string, Transformed>> {
  if (all[entry]) return all;
  const t = await transformOne(entry, appRoot);
  all[entry] = t;
  for (const exp of Object.values(t.exports)) {
    for (const c of exp.composes) {
      if (c.type === "dependency") {
        await transformGraph(resolvePath(dirname(entry), c.specifier), appRoot, all);
      }
    }
  }
  return all;
}

// The space-joined scoped class string for one local name, following composes:
//   local → already scoped · global → as-is · dependency → the target file's name.
function resolveName(
  file: string,
  local: string,
  all: Record<string, ModuleExports>,
  seen = new Set<string>(),
): string {
  const exp = all[file]?.[local];
  if (!exp) return local; // not a module class (shouldn't happen) → pass through
  const parts = [exp.name];
  for (const c of exp.composes) {
    if (c.type === "dependency") {
      const target = resolvePath(dirname(file), c.specifier);
      const k = `${target}::${c.name}`;
      if (seen.has(k)) continue; // guard against circular composes
      seen.add(k);
      parts.push(resolveName(target, c.name, all, seen));
    } else {
      parts.push(c.name); // local (already scoped) or global (unscoped)
    }
  }
  return parts.join(" ");
}

const exportsOnly = (all: Record<string, Transformed>): Record<string, ModuleExports> =>
  Object.fromEntries(Object.entries(all).map(([f, t]) => [f, t.exports]));

// Transform one .module.css (+ its composes deps) → its class map and scoped CSS.
// The CSS is THIS file's rules only; composed rules live in their own files (and so
// appear once in the combined sheet), never inlined here.
export async function transformCssModule(
  file: string,
  appRoot: string,
): Promise<{ map: Record<string, string>; css: string }> {
  const all = await transformGraph(file, appRoot);
  const exports = exportsOnly(all);
  const map: Record<string, string> = {};
  for (const local of Object.keys(all[file]!.exports)) map[local] = resolveName(file, local, exports);
  return { map, css: all[file]!.css };
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
// loaders hand out match the CSS that's served/emitted. composes are references
// (not inlined), so each rule appears once — no dedup pass.
export async function buildModuleCss(
  appDir: string,
  appRoot: string,
): Promise<{ maps: ModuleMaps; css: string | null }> {
  const files = await findModuleCss(appDir);
  if (!files.length) return { maps: {}, css: null };

  const all: Record<string, Transformed> = {};
  for (const file of files) await transformGraph(file, appRoot, all); // picks up out-of-glob deps too
  const exports = exportsOnly(all);

  const maps: ModuleMaps = {};
  for (const file of files) {
    maps[file] = {};
    for (const local of Object.keys(all[file]!.exports)) maps[file][local] = resolveName(file, local, exports);
  }
  // Emit each transformed file's CSS once (sorted), so a composed rule — which lives
  // in its own file — appears exactly once in the combined sheet.
  const css = Object.keys(all)
    .sort()
    .map((f) => all[f]!.css)
    .join("\n");
  return { maps, css };
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
