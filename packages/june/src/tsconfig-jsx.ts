// The app tsconfig's jsxImportSource, shared by BOTH bundle passes (worker + client). rolldown
// reads tsconfig.json itself and emits CONFIGURATION_FIELD_CONFLICT whenever transform.jsx
// ALSO sets importSource — even when both name the same value — so each pass must skip its
// explicit set when the tsconfig already declares "@junejs/core". jsxTransform() is that skip,
// in one place; patching only one pass (the v0.0.41 fix) left the client bundle still warning.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// tsconfig.json is JSONC by convention (comments + trailing commas are idiomatic), and a strict
// JSON.parse failure here silently degrades to "not declared" → the conflict warning reappears.
// Strip comments (`//` only at line-start/after-whitespace so "https://…" in strings survives)
// and trailing commas before parsing.
const stripJsonc = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");

type Tsconfig = { extends?: string; compilerOptions?: { jsxImportSource?: string } };

/** Read the app's tsconfig.json and return compilerOptions.jsxImportSource.
 *  Follows one level of `extends` so apps that inherit from a base tsconfig
 *  (e.g. "@kurajs/docs/tsconfig.kura.json") are handled correctly.
 *  Returns undefined when absent or unreadable. */
export async function appJsxImportSource(appRoot: string): Promise<string | undefined> {
  const read = async (path: string): Promise<Tsconfig | undefined> => {
    try {
      return JSON.parse(stripJsonc(await readFile(path, "utf8"))) as Tsconfig;
    } catch {
      return undefined; // absent or unparsable — treat as "not declared"
    }
  };
  const tc = await read(join(appRoot, "tsconfig.json"));
  if (!tc) return undefined;
  if (tc.compilerOptions?.jsxImportSource) return tc.compilerOptions.jsxImportSource;
  // One level of extends: resolve relative paths and bare package specifiers.
  if (tc.extends) {
    const base = tc.extends.startsWith(".")
      ? join(appRoot, tc.extends)
      : join(appRoot, "node_modules", tc.extends);
    const btc = await read(base);
    if (btc?.compilerOptions?.jsxImportSource) return btc.compilerOptions.jsxImportSource;
  }
  return undefined;
}

/** The transform.jsx both bundles use: June's island JSX runtime, with the explicit importSource
 *  skipped when the app's tsconfig already declares it — rolldown then reads it from tsconfig
 *  silently instead of warning about the (same-value) override. */
export async function jsxTransform(appRoot: string): Promise<{ runtime: "automatic"; importSource?: string }> {
  return {
    runtime: "automatic",
    ...((await appJsxImportSource(appRoot)) === "@junejs/core" ? {} : { importSource: "@junejs/core" }),
  };
}
