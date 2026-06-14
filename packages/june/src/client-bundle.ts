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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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

async function bundleClient(entryFile: string, cwd: string, mode: BundleMode) {
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: entryFile,
    cwd,
    // The client graph is plain web — browser conditions, and React's dev/prod
    // branch resolved at build (no `process` in the browser to read it at runtime).
    platform: "browser",
    transform: { define: { "process.env.NODE_ENV": JSON.stringify(mode) } },
    resolve: { conditionNames: ["browser", "import", "default"] },
  });
  return bundle;
}

// Build the client entry to a single `client.js` string (dev serves this live).
export async function bundleClientToString(entryFile: string, cwd: string): Promise<string> {
  const bundle = await bundleClient(entryFile, cwd, "development");
  const { output } = await bundle.generate({ format: "esm", entryFileNames: "client.js" });
  await bundle.close();
  const entry = output.find((o) => o.type === "chunk" && o.isEntry);
  return entry && entry.type === "chunk" ? entry.code : "";
}

// Build the client entry to `<destDir>/_june/client.js` (build freezes it as an
// asset under the reserved /_june/ prefix; CLIENT_SCRIPT_URL matches).
export async function bundleClientToFile(entryFile: string, cwd: string, destDir: string): Promise<void> {
  const bundle = await bundleClient(entryFile, cwd, "production");
  await mkdir(destDir, { recursive: true });
  await bundle.write({
    dir: destDir,
    format: "esm",
    entryFileNames: "_june/client.js",
    chunkFileNames: "_june/[name]-[hash].js",
  });
  await bundle.close();
}
