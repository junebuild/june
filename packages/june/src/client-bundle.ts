// The client bundle — the host half of v0.1 islands.
//
// The contract layer renders `<june-island>` markers (server) and exposes
// `hydrateIslands` (client). This module is the BUILD/DEV glue that turns an
// app's client entry into the `/client.js` the document loads.
//
// Convention: `app/_client.{tsx,ts,jsx,js}` (the `_` prefix marks it private, so
// the route scanner already ignores it — same convention as `_content.ts`). The
// author registers islands and calls `hydrateIslands` there:
//
//   // app/_client.tsx
//   import { hydrateIslands } from "@junejs/core/islands-client";
//   import { Counter } from "./Counter";
//   hydrateIslands({ Counter });
//
// Absent entry → no `/client.js`, no `clientScript`, the page ships zero JS.
//
// Host-coupled (node:fs + Rolldown), so it lives in @junejs/server, never the pure
// contract layer.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rolldownCssModulesPlugin, type ModuleMaps } from "./css-modules";
import { jsxTransform } from "./tsconfig-jsx";

// The URL the document loads + the asset path the bundle is written to. Single
// source of truth so build (freeze) and dev (live) agree.
export const CLIENT_SCRIPT_URL = "/_june/client.js";
const CLIENT_BASENAME = "_client";
const CLIENT_EXTS = [".tsx", ".ts", ".jsx", ".js"];

// Find the app's client entry, if it has one. `appDir` is the `app/` directory.
export function findClientEntry(appDir: string): string | undefined {
  for (const ext of CLIENT_EXTS) {
    const file = join(appDir, CLIENT_BASENAME + ext);
    if (existsSync(file)) return file;
  }
  return undefined;
}

type BundleMode = "development" | "production";

// True for the logs the client bundle EXPECTS and should not surface. Exported for tests.
// react-server-dom-webpack is an intentional optional dynamic import (client-router-flight's
// defaultDecode): morph apps never install it, so rolldown can't resolve it and keeps it as a
// runtime import() — which rejects in the browser and the nav hard-falls-back BY DESIGN.
// Surfacing that as a red UNRESOLVED_IMPORT block on every build reads as a problem when it's
// the documented graceful-degradation path. Everything else still warns.
export function isExpectedClientLog(log: { code?: string; exporter?: string }): boolean {
  return log.code === "UNRESOLVED_IMPORT" && (log.exporter ?? "").startsWith("react-server-dom-webpack");
}

async function bundleClient(entryFile: string, cwd: string, mode: BundleMode, maps: ModuleMaps = {}) {
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: entryFile,
    cwd,
    // The client graph is plain web — browser conditions, and React's dev/prod
    // branch resolved at build (no `process` in the browser to read it at runtime).
    platform: "browser",
    plugins: [rolldownCssModulesPlugin(maps)], // islands may import .module.css
    transform: {
      define: { "process.env.NODE_ENV": JSON.stringify(mode) },
      // June's island JSX runtime — via the shared jsxTransform, which skips the explicit
      // importSource when the app's tsconfig already declares it (else rolldown emits
      // CONFIGURATION_FIELD_CONFLICT, value-independent). See tsconfig-jsx.ts.
      jsx: await jsxTransform(cwd),
    },
    resolve: { conditionNames: ["browser", "import", "default"] },
    onLog(level, log, handler) {
      if (isExpectedClientLog(log)) return;
      handler(level, log);
    },
  });
  return bundle;
}

// PoC: split build. With a lazy registry (`{ name: () => import("./Island") }`)
// the entry's dynamic imports make rolldown emit ONE chunk per island plus a
// shared chunk for React — so a page downloads only the islands it actually
// renders, not the whole app's union. Returns every chunk keyed by file name
// (the entry is "client.js"); the dev server serves each under /_june/<name>.
export type ClientChunks = Map<string, string>;

export async function bundleClientSplit(
  entryFile: string,
  cwd: string,
  mode: BundleMode,
  maps: ModuleMaps = {},
): Promise<ClientChunks> {
  const bundle = await bundleClient(entryFile, cwd, mode, maps);
  const { output } = await bundle.generate({
    format: "esm",
    entryFileNames: "client.js",
    // [name] (no hash) in dev so the relative `import("./Counter.js")` baked into
    // the entry resolves to a path the dev server can serve by name.
    chunkFileNames: "[name].js",
  });
  await bundle.close();
  const chunks: ClientChunks = new Map();
  for (const o of output) if (o.type === "chunk") chunks.set(o.fileName, o.code);
  return chunks;
}

// Build the client entry to a single `client.js` string (dev serves this live).
export async function bundleClientToString(entryFile: string, cwd: string, maps: ModuleMaps = {}): Promise<string> {
  const bundle = await bundleClient(entryFile, cwd, "development", maps);
  const { output } = await bundle.generate({ format: "esm", entryFileNames: "client.js" });
  await bundle.close();
  const entry = output.find((o) => o.type === "chunk" && o.isEntry);
  return entry && entry.type === "chunk" ? entry.code : "";
}

// Build the client entry and write EVERY emitted chunk/asset under
// `<destDir>/_june/`, each content-hashed by rolldown (immutable-cacheable). With
// a lazy registry (`{ name: () => import("./Island") }`) rolldown code-splits one
// chunk per island + a shared React chunk, and the entry's relative `import()`s
// already point at the hashed siblings — so they must ALL ship, not just the
// entry (writing only the entry leaves those imports 404ing in production).
// Returns the ENTRY asset filename (`_june/client.<hash>.js`) for the document.
export async function bundleClientToFile(entryFile: string, cwd: string, destDir: string, maps: ModuleMaps = {}): Promise<string> {
  const bundle = await bundleClient(entryFile, cwd, "production", maps);
  // Hash entry + split chunks; all under _june/ so the entry's relative imports
  // (`./Counter-<hash>.js`) resolve there when served from /_june/client.<hash>.js.
  const { output } = await bundle.generate({
    format: "esm",
    // hex hashes keep the asset names in the historical `client.<8hex>.js` shape
    // (lowercase hex) the document + parity tests expect, now that there can be
    // sibling chunks too.
    hashCharacters: "hex",
    entryFileNames: "_june/client.[hash].js",
    chunkFileNames: "_june/[name]-[hash].js",
    assetFileNames: "_june/[name]-[hash][extname]",
  });
  await bundle.close();

  let entryFileName = "";
  for (const o of output) {
    const dest = join(destDir, o.fileName);
    await mkdir(dirname(dest), { recursive: true });
    if (o.type === "chunk") {
      await writeFile(dest, o.code);
      if (o.isEntry) entryFileName = o.fileName;
    } else {
      await writeFile(dest, o.source);
    }
  }
  return entryFileName;
}
