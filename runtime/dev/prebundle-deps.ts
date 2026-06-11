// Dev-only npm pre-bundling for PURE-JUNE client Fast Refresh — the Bun.build
// analogue of Vite's optimizeDeps (chosen over Vite after benchmarking: faster,
// lighter, single-process, no Node sidecar). June stays the only server; this is
// a dev-time LIBRARY step it shells to, like build.ts.
//
//   scan "use client" modules -> collect bare (npm) imports
//   + baseline client-runtime deps (react family + Flight client)
//   -> Bun.build each as an ESM entry WITH code splitting (one shared React
//      instance across all of them) in DEVELOPMENT mode (Fast Refresh needs
//      React's dev build) -> runtime/dist/deps/*.js
//   -> manifest.json: bare specifier -> served URL (/@june/deps/<name>.js)
//   -> cache key (package.json + lockfile + dep set); skip if unchanged.
//
// The un-bundled client module server rewrites bare imports to the manifest URLs.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "runtime/app");
const OUT_DIR = join(ROOT, "runtime/dist/deps");
const STUB_DIR = join(ROOT, "runtime/dist/.dep-stubs"); // inside project so node_modules resolves

// What the client graph always needs (the dev client runtime + transpiled app
// modules import these). react-dom/client for hydrateRoot; jsx runtimes for
// transpiled TSX; the Flight client to consume RSC payloads.
const BASELINE = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-server-dom-webpack/client.browser",
  "react-refresh/runtime", // dev client Fast Refresh runtime (served, set up before React)
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function firstStatementIsUseClient(src: string): boolean {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    return t.startsWith('"use client"') || t.startsWith("'use client'");
  }
  return false;
}

// Collect bare (non-relative, non-absolute) import specifiers from a source file.
function bareImports(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const spec = m[1] ?? m[2];
    if (!spec || spec.startsWith(".") || spec.startsWith("/")) continue;
    specs.push(spec);
  }
  return specs;
}

// Discover every npm specifier the client graph touches.
function discoverDeps(): string[] {
  const found = new Set(BASELINE);
  for (const f of walk(APP_DIR)) {
    if (!/\.(tsx|ts|jsx|mjs)$/.test(f) || f.endsWith("_client-manifest.ts")) continue;
    const src = readFileSync(f, "utf8");
    if (!firstStatementIsUseClient(src)) continue; // only client modules ship to the browser
    for (const spec of bareImports(src)) found.add(spec);
  }
  return [...found].sort();
}

// Specifier -> safe filename (react-dom/client -> react-dom__client.js).
const fileFor = (spec: string) => spec.replace(/\//g, "__") + ".js";
const urlFor = (spec: string) => "/@june/deps/" + fileFor(spec);

function cacheKey(deps: string[]): string {
  const parts = [deps.join(",")];
  for (const f of ["package.json", "bun.lock", "bun.lockb", "package-lock.json"]) {
    const p = join(ROOT, f);
    if (existsSync(p)) parts.push(f + ":" + readFileSync(p));
  }
  return Bun.hash(parts.join("\0")).toString(16);
}

// Node builtins resolve to Bun's BROWSER polyfills, whose exports differ from
// node's runtime exports (e.g. buffer has no SlowBuffer in the browser). So we
// re-export `*` from the polyfill instead of enumerating node's names.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "events", "fs", "http", "https", "module", "net", "os",
  "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
  "worker_threads", "zlib", "inspector",
]);
const isNodeBuiltin = (s: string) => {
  const b = (s.startsWith("node:") ? s.slice(5) : s).split("/")[0];
  return NODE_BUILTINS.has(b);
};

const isReactFamily = (s: string) =>
  s === "react" ||
  s.startsWith("react/") ||
  s.startsWith("react-dom") ||
  s.startsWith("react-server-dom-webpack") ||
  s.startsWith("react-refresh");

// React subpaths a third-party dep might import; kept EXTERNAL in the npm build so
// every dep shares the ONE React instance (resolved at runtime: browser via import
// map, SSR via the loader's vendor) instead of bundling its own copy.
const REACT_EXTERNAL = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"];

// Build a group of deps into OUT_DIR as ESM entries (one file per spec, shared
// chunks), with EXPLICIT static named re-exports. `export *` from a CJS dep only
// forwards `default` statically, so `import { useState } from "react"` breaks —
// enumerate names at build time and emit `export { a, b } from "dep"` (what
// Vite/esbuild do via cjs-module-lexer).
async function buildGroup(specs: string[], external: string[]): Promise<number> {
  if (specs.length === 0) return 0;
  rmSync(STUB_DIR, { recursive: true, force: true });
  mkdirSync(STUB_DIR, { recursive: true });

  const entrypoints: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const stub = join(STUB_DIR, `d${i}.js`);
    let code: string;
    if (isNodeBuiltin(spec)) {
      // Re-export whatever the (ESM) browser polyfill provides — don't enumerate
      // node's runtime export set.
      code =
        `export * from ${JSON.stringify(spec)};\n` +
        `import * as __ns from ${JSON.stringify(spec)};\n` +
        `export default ("default" in __ns) ? __ns.default : __ns;\n`;
      writeFileSync(stub, code);
      entrypoints.push(stub);
      continue;
    }
    try {
      const ns: Record<string, unknown> = await import(spec);
      const names = Object.keys(ns).filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
      const hasDefault = "default" in ns;
      code = names.length ? `export { ${names.join(", ")} } from ${JSON.stringify(spec)};\n` : "";
      code += hasDefault
        ? `export { default } from ${JSON.stringify(spec)};\n`
        : `import * as __ns from ${JSON.stringify(spec)};\nexport default __ns;\n`;
    } catch (e) {
      console.error(`[deps] warn: could not enumerate ${spec} (${(e as Error).message.split("\n")[0]}); namespace fallback`);
      code =
        `export * from ${JSON.stringify(spec)};\n` +
        `import * as __ns from ${JSON.stringify(spec)};\n` +
        `export default ("default" in __ns) ? __ns.default : __ns;\n`;
    }
    writeFileSync(stub, code);
    entrypoints.push(stub);
  }

  const t0 = performance.now();
  const res = await Bun.build({
    entrypoints,
    outdir: OUT_DIR,
    root: STUB_DIR,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: false,
    sourcemap: "external",
    define: { "process.env.NODE_ENV": '"development"' }, // dev React => Fast Refresh works
    external,
  });
  if (!res.success) {
    for (const m of res.logs) console.error(m);
    throw new Error("[deps] Bun.build failed");
  }

  // Rename each entry output (d<i>.js) to its specifier filename (+ sourcemap).
  specs.forEach((spec, i) => {
    const from = join(OUT_DIR, `d${i}.js`);
    const to = join(OUT_DIR, fileFor(spec));
    if (existsSync(from)) {
      writeFileSync(to, readFileSync(from));
      rmSync(from, { force: true });
      const fromMap = from + ".map";
      if (existsSync(fromMap)) {
        writeFileSync(to + ".map", readFileSync(fromMap));
        rmSync(fromMap, { force: true });
      }
    }
  });
  return performance.now() - t0;
}

async function main() {
  const deps = discoverDeps();
  const key = cacheKey(deps);
  const keyFile = join(OUT_DIR, ".cache-key");
  const manifestFile = join(OUT_DIR, "manifest.json");

  if (existsSync(keyFile) && readFileSync(keyFile, "utf8") === key && existsSync(manifestFile)) {
    console.error(`[deps] cache hit (${deps.length} deps) — skipping pre-bundle`);
    return;
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // Shim webpack globals so browser-only deps (the Flight client) load for enumeration.
  (globalThis as any).__webpack_require__ ??= () => ({});
  (globalThis as any).__webpack_chunk_load__ ??= async () => {};

  // Build 1: React family (bundles React). Build 2: everyone else with React
  // EXTERNAL, so React-importing deps (zustand, react-query) don't bundle their
  // own React copy — they resolve to the single shared instance at runtime.
  const reactFamily = deps.filter(isReactFamily);
  const npmDeps = deps.filter((d) => !isReactFamily(d));
  const ms = (await buildGroup(reactFamily, [])) + (await buildGroup(npmDeps, REACT_EXTERNAL));

  const manifest: Record<string, string> = {};
  for (const spec of deps) manifest[spec] = urlFor(spec);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  writeFileSync(keyFile, key);
  rmSync(STUB_DIR, { recursive: true, force: true });
  console.error(`[deps] pre-bundled ${deps.length} deps (${reactFamily.length} react, ${npmDeps.length} npm) in ${ms.toFixed(0)}ms`);
}

await main();
