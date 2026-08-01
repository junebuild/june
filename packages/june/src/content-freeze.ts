// The content FREEZE: content/<collection>/*.md → app/_content.ts, the
// build-time content manifest. Extracted from build.ts — this is the whole
// "remove node:fs from the worker graph" step, including the self-healing
// bootstrap for wrapper-generated configs that import app/_content.ts.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ContentSource, JuneConfig } from "@junejs/core/config";
import { findJuneConfigPath, loadJuneConfig } from "./config-loader";
import { generateContentModule } from "./content";

// content/<collection>/*.md → app/_content.ts (the build-time content manifest).
// This is the FREEZE that removes node:fs from the worker graph: routes import
// frozen entries from ./_content instead of reading the filesystem at request.
//
// Extra sources (config `content.sources`) merge dirs OUTSIDE `content/` into named
// collections — the docs-as-code seam (a repo's own `docs/` feeds the site directly).
// Their dirs resolve against the app root, so "../docs" reaches a sibling directory.
//
// Locale buckets are DECLARED, not guessed: only dirs named in config i18n
// (defaultLocale + locales keys) split off as locale mirrors. Guessing by shape
// (the old BCP-47 regex) silently swallowed any 2–3-letter folder — `cli/`,
// `sdk/`, `api/`, `faq/` all read as locales and vanished from the default set.
// No i18n config ⇒ NO buckets (an undeclared locale is not a locale). The regex
// remains only as the fallback when the config itself cannot be loaded.
export async function generateContent(appRoot: string): Promise<string[]> {
  const contentDir = join(appRoot, "content");
  // app/ is the output dir for _content.ts (and the seed). Ensure it exists so the now-always
  // write can't throw an opaque ENOENT when called standalone (e.g. `june gen`); the full build's
  // own "no app/ directory" check runs earlier, so this never masks that clearer error.
  await mkdir(join(appRoot, "app"), { recursive: true });
  const emit = async (sources: ContentSource[], knownLocales: readonly string[] | undefined): Promise<string[]> => {
    // Emission (incl. the per-locale layout and source merging) lives in ./content so it's
    // pure and unit-testable; this stays the thin fs wrapper.
    const { code, names } = generateContentModule(contentDir, knownLocales, sources);
    // Always write, even with zero collections: `code` still carries the canonical ContentEntry
    // type, which is the single source of truth the bootstrap seed appends its stubs against (an
    // app with no local content/ — docs-as-code — needs this valid empty module to exist).
    await writeFile(join(appRoot, "app", "_content.ts"), code);
    return names;
  };
  const resolveSources = (sources: ContentSource[]): ContentSource[] =>
    sources.map((s) => ({ ...s, dir: resolve(appRoot, s.dir) }));
  const declaredLocales = (config: JuneConfig): string[] =>
    config.i18n ? [...new Set([config.i18n.defaultLocale, ...Object.keys(config.i18n.locales)])] : [];
  // Learn sources + locales from june.config.ts — TOLERANTLY. A wrapper-generated config (e.g.
  // Kura's) imports app/_content.ts, which does not exist before the FIRST freeze. So on a failed
  // config load: generate a default scan to create that import's target, then re-probe the config
  // and regenerate with the real sources/locales. Self-healing, no bootstrap flag. Content errors
  // from emit() (slug collision, missing source dir) stay loud — only the CONFIG LOAD is tolerated.
  let config: JuneConfig | null = null;
  try {
    config = await loadJuneConfig(appRoot);
  } catch {
    /* two-pass below */
  }
  if (config) return emit(resolveSources(config.content?.sources ?? []), declaredLocales(config));
  // Pass 1 (throwaway when the probe succeeds): legacy regex locale detection, since the
  // declared set is unknowable without the config. emit() writes app/_content.ts with the
  // canonical ContentEntry type plus a `const` per collection FOUND — but a docs-as-code app
  // keeps ALL content in external content.sources with NO local content/, so it finds zero
  // collections and thus emits no EXPORTS (no `DOCS`). seedContentImports then appends stubs for
  // the exact names the config imports (e.g. Kura's `import { DOCS }`), so the re-probe can load.
  const names = await emit([], undefined);
  await seedContentImports(appRoot);
  const probed = probeConfigFresh(appRoot);
  if (probed === null) {
    console.warn("[june gen] june.config.ts failed to load — content.sources/i18n locales (if any) not applied");
    return names;
  }
  return emit(resolveSources(probed.sources), probed.locales);
}

// Bootstrap seed: ensure app/_content.ts exports every name the config imports from it, so the
// re-probe's config load resolves BEFORE the first real freeze. A docs-as-code app (content only
// in external content.sources, no local content/) leaves Pass 1's default scan empty — nothing
// seeds the collections — so here we append stubs for the EXACT named imports the config takes
// from the app/_content module (a bare `import { DOCS }` of it → `export const DOCS = []`). The
// caller's emit() already wrote the module's canonical ContentEntry type (even when empty), so the
// stubs type against that single source of truth. Overwritten by the real freeze that follows a
// successful probe; a no-op once content exists.
async function seedContentImports(appRoot: string): Promise<void> {
  const cfgPath = findJuneConfigPath(appRoot);
  if (!cfgPath) return;
  const contentFile = join(appRoot, "app", "_content.ts");
  const current = existsSync(contentFile) ? await readFile(contentFile, "utf8") : "";
  const cfgSrc = await readFile(cfgPath, "utf8");
  // Only stub valid JS identifiers — a name carrying comments/other tokens (rare, but valid TS)
  // must never reach `new RegExp(...)` (would throw) or the emitted stub (would be invalid TS).
  const isIdent = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
  // A Set so a name matched more than once (e.g. a comment mentioning the import + the real one)
  // yields ONE stub — a duplicate `export const <name>` would be invalid TS. Also skip names the
  // module already exports.
  const seen = new Set<string>();
  const stubs: string[] = [];
  // Each named `import { A, B as C }` the config takes from the app/_content module → stub each.
  // The `(?:\.\w+)?` tolerates an explicit extension (`app/_content.ts`/`.js`/`.mjs`), which
  // NodeNext / verbatimModuleSyntax configs require — else the import goes undetected and unstubbed.
  for (const m of cfgSrc.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*app\/_content(?:\.\w+)?["']/g)) {
    // Strip block + line comments from the specifier list BEFORE splitting: a valid
    // `{ DOCS /* keep */ }` must still yield the identifier `DOCS` (not be dropped), and a comment
    // could otherwise carry a `,` that breaks the split. Then drop `type` markers per specifier.
    const inner = (m[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const part of inner.split(",")) {
      const name = part.replace(/\btype\b/g, "").split(/\s+as\s+/).pop()?.trim();
      if (!name || !isIdent(name) || seen.has(name)) continue;
      seen.add(name);
      // Escape before interpolating: a valid identifier may contain `$`, a regex metachar (an
      // anchor), which would corrupt the already-exported check. The stub below uses the raw name.
      const reName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`export (?:const|function|type) ${reName}\\b`).test(current)) {
        stubs.push(`export const ${name}: ContentEntry[] = [];`);
      }
    }
  }
  if (stubs.length) await writeFile(contentFile, current + stubs.join("\n") + "\n");
}

// Re-probe ONLY the content-relevant config (sources + declared i18n locales) in a FRESH
// subprocess. The bootstrap retry can't re-import in-process: a failed ESM load is cached as
// errored, and Bun also caches the failed RESOLUTION of the config's own imports — so a
// same-process retry (even cache-busted) re-rejects after the missing app/_content.ts appears.
// A child process has a clean module map, and both fields are plain JSON, so they survive the
// pipe. Returns null when the config is genuinely broken.
function probeConfigFresh(appRoot: string): { sources: ContentSource[]; locales: string[] } | null {
  const path = findJuneConfigPath(appRoot);
  if (!path) return { sources: [], locales: [] };
  // Markers isolate the JSON from anything the config prints at import time. `.then` (not TLA)
  // so the eval works as CJS under both `bun -e` and `node -e`; execArgv carries loader flags
  // (e.g. --experimental-strip-types) so the child can read the same TS config the parent does.
  const code =
    `import(${JSON.stringify(pathToFileURL(path).href)}).then(` +
    `(m) => { const c = m.default ?? {}; process.stdout.write("\\n__JUNE_CONTENT__" + JSON.stringify({ ` +
    `sources: c.content?.sources ?? [], ` +
    `locales: c.i18n ? [...new Set([c.i18n.defaultLocale, ...Object.keys(c.i18n.locales ?? {})])] : [] ` +
    `}) + "__END__"); }, () => process.exit(42));`;
  try {
    const out = execFileSync(process.execPath, [...process.execArgv, "-e", code], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/__JUNE_CONTENT__(.*?)__END__/s);
    return m ? (JSON.parse(m[1]!) as { sources: ContentSource[]; locales: string[] }) : null;
  } catch {
    return null;
  }
}
