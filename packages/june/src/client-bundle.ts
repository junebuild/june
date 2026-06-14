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

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rolldownCssModulesPlugin, type ModuleMaps } from "./css-modules";

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

async function bundleClient(entryFile: string, cwd: string, mode: BundleMode, maps: ModuleMaps = {}) {
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: entryFile,
    cwd,
    // The client graph is plain web — browser conditions, and React's dev/prod
    // branch resolved at build (no `process` in the browser to read it at runtime).
    platform: "browser",
    plugins: [rolldownCssModulesPlugin(maps)], // islands may import .module.css
    transform: { define: { "process.env.NODE_ENV": JSON.stringify(mode) } },
    resolve: { conditionNames: ["browser", "import", "default"] },
  });
  return bundle;
}

// Build the client entry to a single `client.js` string (dev serves this live).
export async function bundleClientToString(entryFile: string, cwd: string, maps: ModuleMaps = {}): Promise<string> {
  const bundle = await bundleClient(entryFile, cwd, "development", maps);
  const { output } = await bundle.generate({ format: "esm", entryFileNames: "client.js" });
  await bundle.close();
  const entry = output.find((o) => o.type === "chunk" && o.isEntry);
  return entry && entry.type === "chunk" ? entry.code : "";
}

// Build the client entry, content-hash it, and write `<destDir>/_june/client.<hash>.js`
// (immutable-cacheable, like the hashed CSS). Returns the asset filename
// (`_june/client.<hash>.js`) so the build can freeze its URL into the document.
export async function bundleClientToFile(entryFile: string, cwd: string, destDir: string, maps: ModuleMaps = {}): Promise<string> {
  const bundle = await bundleClient(entryFile, cwd, "production", maps);
  const { output } = await bundle.generate({ format: "esm", entryFileNames: "client.js" });
  await bundle.close();
  const entry = output.find((o) => o.type === "chunk" && o.isEntry);
  const code = entry && entry.type === "chunk" ? entry.code : "";
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
  const fileName = `_june/client.${hash}.js`;
  const dest = join(destDir, fileName);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, code);
  return fileName;
}
