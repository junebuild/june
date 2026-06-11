// Builds the two bare-V8 bundles. Target "browser" avoids node builtins;
// the react-server condition is the ONLY difference between them.

async function build(
  entry: string,
  outfile: string,
  conditions: string[],
  format: "iife" | "esm" = "iife",
) {
  const args = [
    "build",
    entry,
    "--outfile",
    outfile,
    "--target=browser",
    `--format=${format}`,
    '--define:process.env.NODE_ENV="production"',
  ];
  for (const c of conditions) args.push("--conditions", c);

  const proc = Bun.spawn(["bun", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`build failed: ${entry}`);
}

// Auto-generate the client manifest from the app's "use client" modules, so
// neither the SSR entry nor the browser bundle has to register them by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { generateClientManifest } from "./dev/client-manifest.ts";

generateClientManifest("runtime/app");

// iife bundles: loaded via execute_script (default snapshot path).
await build("runtime/js/server-entry.tsx", "runtime/dist/server.js", ["react-server"]);
await build("runtime/js/ssr-entry.tsx", "runtime/dist/ssr.js", []);

// esm bundles: loaded via the real ModuleLoader (MODULES=1 path).
await build("runtime/js/server-entry.tsx", "runtime/dist/server.mjs", ["react-server"], "esm");
await build("runtime/js/ssr-entry.tsx", "runtime/dist/ssr.mjs", [], "esm");

// react-server vendor: react (react-server build) + Flight renderer, re-exported.
// App modules import "react"/"react-server-dom-webpack/server"; the custom loader
// resolves both to this, so un-bundled app code shares one React instance.
await build("runtime/js/vendor-server.ts", "runtime/dist/vendor-server.mjs", ["react-server"], "esm");
// client vendor: NORMAL React + react-dom SSR + Flight client (no condition).
await build("runtime/js/vendor-client.ts", "runtime/dist/vendor-client.mjs", [], "esm");

// browser hydration bundle (for the apploader server's HTML responses).
await build("runtime/js/client-entry.tsx", "runtime/dist/client.js", [], "esm");

// DEV client: React + Flight client EXTERNAL (served un-bundled from /@june/deps,
// one shared instance with un-bundled client components) so Fast Refresh works.
await buildDevClient();

console.log("built runtime/dist/{server,ssr}.{js,mjs} + vendor-{server,client}.mjs + client.js + dev-client.js");

async function buildDevClient() {
  const externals = [
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom",
    "react-dom/client",
    "react-server-dom-webpack/client.browser",
  ];
  const args = [
    "build",
    "runtime/js/dev-client-entry.tsx",
    "--outfile",
    "runtime/dist/dev-client.js",
    "--target=browser",
    "--format=esm",
    '--define:process.env.NODE_ENV="development"',
  ];
  for (const e of externals) args.push("--external", e);
  const proc = Bun.spawn(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("dev-client build failed");

  // Rewrite the kept-external bare specifiers to their /@june/deps URLs (must
  // match prebundle-deps.ts naming: "/" -> "__").
  let code = readFileSync("runtime/dist/dev-client.js", "utf8");
  const urlFor = (s: string) => `/@june/deps/${s.replace(/\//g, "__")}.js`;
  for (const e of externals) {
    code = code.replaceAll(`"${e}"`, `"${urlFor(e)}"`).replaceAll(`'${e}'`, `'${urlFor(e)}'`);
  }
  writeFileSync("runtime/dist/dev-client.js", code);
  console.log("built runtime/dist/dev-client.js (externals -> /@june/deps)");
}
