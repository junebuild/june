// CSS — the human surface's styling. Convention over import: if `app/global.css`
// exists, June auto-links it (no `import "./global.css"`); dev serves it, build
// emits it as an asset, both at /global.css (parity-safe, like /client.js).
//
// Floor: plain CSS, zero deps. Blessed: if global.css opts into Tailwind
// (`@import "tailwindcss"`), June compiles it via the app's own Tailwind v4
// (resolved from the app, not bundled into June) — Tailwind auto-detects the
// content it scans. CSS never touches the agent projections (.md/.json/mcp).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const STYLES_URL = "/global.css";
const GLOBAL_CSS = "global.css";

// app/global.css, or null when the app declares no stylesheet.
export function findGlobalCss(appDir: string): string | null {
  const p = join(appDir, GLOBAL_CSS);
  return existsSync(p) ? p : null;
}

const usesTailwind = (css: string) => /@import\s+["']tailwindcss["']|@tailwind\b/.test(css);

// Resolve a tool from the APP's node_modules (Tailwind/postcss are the app's
// deps, not June's). Returns null when absent.
function resolveFromApp(specifier: string, appDir: string): string | null {
  try {
    return createRequire(pathToFileURL(join(appDir, "package.json"))).resolve(specifier);
  } catch {
    return null;
  }
}

async function compileTailwind(
  css: string,
  file: string,
  appDir: string,
  minify: boolean,
): Promise<string | null> {
  const postcssPath = resolveFromApp("postcss", appDir);
  const tailwindPath = resolveFromApp("@tailwindcss/postcss", appDir);
  if (!postcssPath || !tailwindPath) return null;
  const postcss = ((await import(postcssPath)) as { default: (p: unknown[]) => { process(css: string, opts: { from: string }): Promise<{ css: string }> } }).default;
  const tailwind = ((await import(tailwindPath)) as { default: (opts?: unknown) => unknown }).default;
  // Tailwind v4 only emits the classes the project actually uses (content
  // detection = tree-shaking). For build we ALSO minify via its Lightning CSS
  // optimizer; dev stays unminified for readability.
  const plugin = minify ? tailwind({ optimize: { minify: true } }) : tailwind();
  const result = await postcss([plugin]).process(css, { from: file });
  return result.css;
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
    if (compiled !== null) return compiled;
    console.warn(
      "[june] global.css uses Tailwind but @tailwindcss/postcss isn't installed — serving raw CSS.",
    );
  }
  return css;
}
