// CSS — the human surface's styling. Convention over import: if `app/global.css`
// exists, June auto-links it (no `import "./global.css"`). Dev serves it at the
// stable /_june/global.css; build content-hashes it to /_june/global.<hash>.css
// (served immutable). Only the asset HREF diverges dev↔built, never the rendered
// structure — so dev/built parity (the agent surface) holds.
//
// Floor: plain CSS, zero deps — Lightning CSS (the SAME Rust engine Tailwind v4 uses) handles
// nesting/prefix/minify. Blessed: if global.css opts into Tailwind (`@import "tailwindcss"`), June
// compiles it via the app's own Tailwind v4 ENGINE DIRECTLY — @tailwindcss/node + the @tailwindcss/oxide
// Rust scanner (the first-party Vite-plugin path, not PostCSS) — resolved from the app, napi-portable
// across Bun and Node. CSS never touches the agent projections (.md/.json/mcp).

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Targets } from "lightningcss"; // type-only — never enters the graph

// Framework-emitted assets live under the reserved /_june/ prefix so they never
// collide with — or squat on — a user's own paths (cf. Next /_next/, Astro
// /_astro/). Build content-hashes the file under here; this is the dev URL.
export const STYLES_URL = "/_june/global.css";
const GLOBAL_CSS = "global.css";

// app/global.css, or null when the app declares no stylesheet.
export function findGlobalCss(appDir: string): string | null {
  const p = join(appDir, GLOBAL_CSS);
  return existsSync(p) ? p : null;
}

const usesTailwind = (css: string) => /@import\s+["']tailwindcss["']|@tailwind\b/.test(css);

// True when app/global.css opts into Tailwind. Sync (build-time, tiny file) so the document config —
// built synchronously in dev (app.ts) and the build (build.ts) — can default `cssReset` off when
// Tailwind is present: its Preflight IS the reset, so June need not add its own baseline reset.
export function globalCssUsesTailwind(appDir: string): boolean {
  const p = join(appDir, GLOBAL_CSS);
  try {
    return existsSync(p) && usesTailwind(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
}

// Resolve a tool from the APP's node_modules (Tailwind/postcss are the app's
// deps, not June's). Returns null when absent.
function resolveFromApp(specifier: string, appDir: string): string | null {
  try {
    return createRequire(pathToFileURL(join(appDir, "package.json"))).resolve(specifier);
  } catch {
    return null;
  }
}

// Browser targets for autoprefix + syntax lowering (CSS nesting, :is(), oklch,
// logical properties, …). June adds NO dep here: if the app installs `browserslist`
// its config (or the browserslist defaults) drives the targets; otherwise a baked,
// broadly-supported baseline. Override per app the standard way — a `browserslist`
// field in package.json or a .browserslistrc.
const v = (major: number, minor = 0): number => (major << 16) | (minor << 8);
const DEFAULT_TARGETS: Targets = { chrome: v(107), edge: v(107), firefox: v(104), safari: v(16) };

let targetsCache: { appDir: string; targets: Targets } | null = null;
export async function cssTargets(appDir: string): Promise<Targets> {
  if (targetsCache?.appDir === appDir) return targetsCache.targets;
  let targets: Targets = DEFAULT_TARGETS;
  const blPath = resolveFromApp("browserslist", appDir);
  if (blPath) {
    try {
      const browserslist = ((await import(blPath)) as { default: (q?: unknown, o?: unknown) => string[] }).default;
      const { browserslistToTargets } = await import("lightningcss");
      targets = browserslistToTargets(browserslist(undefined, { path: appDir }));
    } catch {
      /* malformed config / resolution race → keep the baked default */
    }
  }
  targetsCache = { appDir, targets };
  return targets;
}

// Minimal type surface of the bits of Tailwind v4's engine we drive directly.
type TwSource = { base: string; pattern: string; negated: boolean };
type TwCompiler = { build(candidates: string[]): string; sources: TwSource[]; features: number };
type TwNode = {
  compile(css: string, opts: { base: string; onDependency: (p: string) => void }): Promise<TwCompiler>;
  optimize(css: string, opts: { minify: boolean }): { code: string };
  Features: { Utilities: number };
};
type TwOxide = { Scanner: new (o: { sources: TwSource[] }) => { scan(): string[] } };

// Compile Tailwind v4 via its programmatic engine — @tailwindcss/node (compile + Lightning CSS optimize)
// + @tailwindcss/oxide (the Rust content Scanner) — the SAME direct path the first-party Vite plugin
// uses, NOT PostCSS. No postcss dependency or extra parse pass; the Oxide scanner (Rust) finds class
// candidates and the compiler emits only those (tree-shaken). Engine resolved from the APP (its dep,
// not June's); napi works identically on Bun and Node. Returns null when Tailwind isn't installed.
async function compileTailwind(
  css: string,
  file: string,
  appDir: string,
  minify: boolean,
): Promise<string | null> {
  const nodePath = resolveFromApp("@tailwindcss/node", appDir);
  const oxidePath = resolveFromApp("@tailwindcss/oxide", appDir);
  if (!nodePath || !oxidePath) return null;
  const { compile, optimize, Features } = (await import(nodePath)) as TwNode;
  const { Scanner } = (await import(oxidePath)) as TwOxide;
  const base = dirname(file); // the CSS's dir — resolves @import / @source / auto-detection
  const compiler = await compile(css, { base, onDependency: () => {} });
  // Scan the project (app root) plus whatever the compiler declares; Oxide skips node_modules/.gitignore.
  const sources: TwSource[] = [{ base: dirname(appDir), pattern: "**/*", negated: false }, ...compiler.sources];
  const candidates = compiler.features & Features.Utilities ? new Scanner({ sources }).scan() : [];
  const out = compiler.build(candidates);
  // Lightning CSS optimize for build (minify + prefix/lower); dev stays readable.
  return minify ? optimize(out, { minify: true }).code : out;
}

// Dev-only memo. The dev server re-fetches /global.css on EVERY navigation, but
// the CSS only changes on edit — so compiling each time wastes ~18ms a nav (and
// ~145ms the first time, Tailwind's design-system build). Cache it; the .css
// watcher calls invalidateCss() on edit, and a .tsx class change restarts the
// whole dev process (cache starts empty there), so the cache never goes stale.
let devCache: { appDir: string; css: string | null } | null = null;

export async function processCssCached(appDir: string): Promise<string | null> {
  if (devCache?.appDir === appDir) return devCache.css;
  const css = await processCss(appDir);
  devCache = { appDir, css };
  return css;
}

export function invalidateCss(): void {
  devCache = null;
}

// Minify a finished stylesheet with Lightning CSS — and, given `targets`, ALSO
// autoprefix + lower modern syntax (nesting, :is(), oklch, logical props) for the
// target browsers. The same engine Tailwind v4 optimizes with, so all of June's
// build-time CSS comes out consistently. It never touches identifiers, so scoped
// CSS-module class names survive intact (hydration stays byte-identical to SSR).
// Lazy import: build/dev-time only, never in the worker graph. Falls back to the
// input if Lightning CSS can't parse it, so it can never break a build.
export async function minifyCss(css: string, filename = "input.css", targets?: Targets): Promise<string> {
  try {
    const { transform } = await import("lightningcss");
    const { code } = transform({ filename, code: Buffer.from(css), minify: true, targets });
    return code.toString();
  } catch (e) {
    console.warn("[june] CSS minify failed; emitting unminified:", e);
    return css;
  }
}

// Read + process app/global.css → the CSS to serve/emit. null when absent.
// build passes { minify: true } (optimized, deployable); dev leaves it readable.
export async function processCss(
  appDir: string,
  opts: { minify?: boolean } = {},
): Promise<string | null> {
  const file = findGlobalCss(appDir);
  if (!file) return null;
  const css = await readFile(file, "utf8");
  if (usesTailwind(css)) {
    const compiled = await compileTailwind(css, file, appDir, !!opts.minify).catch((e) => {
      console.warn("[june] Tailwind compile failed; serving raw CSS:", e);
      return null;
    });
    if (compiled !== null) return compiled; // Tailwind already minified when asked
    console.warn(
      "[june] global.css uses Tailwind but @tailwindcss/node + @tailwindcss/oxide aren't installed — serving raw CSS.",
    );
  }
  // Plain CSS (or the Tailwind fallback): minify + autoprefix/lower for the app's
  // browser targets, so the non-Tailwind path is optimized too. (Tailwind v4 owns
  // its own targeting; dev stays readable and untargeted.)
  return opts.minify ? await minifyCss(css, file, await cssTargets(appDir)) : css;
}
