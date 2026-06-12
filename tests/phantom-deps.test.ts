// Phantom-dependency audit: every external import in every publishable
// package must be declared in its dependencies or peerDependencies. The
// monorepo can't catch these at runtime — a root devDependency (rolldown,
// 0.0.6) resolves fine here and never for an npm consumer — so the check
// has to be static.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["core", "cli", "june", "juno", "create-june"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(e)) out.push(full);
  }
  return out;
}

// "react-dom/client" → "react-dom"; "@junejs/core/route" → "@junejs/core"
function packageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("bun")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function externalImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs = [
    // static imports/exports-from and dynamic import("literal")
    ...src.matchAll(/(?:from|import\()\s*"([^"]+)"/g),
  ].map((m) => m[1]!);
  return specs.map(packageName).filter((n): n is string => n !== null);
}

describe("published packages declare every import", () => {
  for (const p of PACKAGES) {
    test(p, () => {
      const root = join(import.meta.dir, "../packages", p);
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        pkg.name, // self-references (e.g. build codegen importing @junejs/server/worker)
      ]);
      const files = [...sourceFiles(join(root, "src")), join(root, "bin.mjs")].filter((f) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      });
      const phantom = new Set<string>();
      for (const f of files) {
        for (const name of externalImports(f)) {
          if (!declared.has(name)) phantom.add(name);
        }
      }
      expect([...phantom]).toEqual([]);
    });
  }
});
