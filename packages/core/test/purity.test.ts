// The contract layer's defining invariant: it is PURE — no `node:*`, no `Bun.*`,
// no statically-resolvable host import anywhere the worker graph can reach. The
// PoC learned this the hard way (a stray `node:async_hooks` broke workerd
// assets-mode chunk registration). These tests make the invariant a CI gate
// instead of a code-review hope.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => join(SRC, f));
}

// Strip comments so the guard analyzes CODE, not the prose that documents why
// these very patterns are forbidden. Block comments first, then line comments —
// the `[^:]` guard keeps `https://` URLs intact.
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("contract layer purity", () => {
  test("no static `node:*` or `bun` imports in any src file", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      // Static `import ... from "node:..."` / `from "bun"`.
      if (/\bfrom\s+["']node:/.test(code)) offenders.push(`${file}: static node: import`);
      if (/\bfrom\s+["']bun["']/.test(code)) offenders.push(`${file}: static bun import`);
      // Literal dynamic import of a host module — only NON-literal specifiers
      // (resolved through a variable) are allowed, and only inside a factory.
      if (/import\(\s*["'](node:|bun)/.test(code)) offenders.push(`${file}: literal host dynamic import`);
      // No `Bun.` global usage.
      if (/\bBun\./.test(code)) offenders.push(`${file}: Bun.* global`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("package resolution (reminder #1: real names + subpath exports)", () => {
  const subpaths = [
    "@junejs/core",
    "@junejs/core/route",
    "@junejs/core/config",
    "@junejs/core/document",
    "@junejs/core/agent",
    "@junejs/core/mcp",
    "@junejs/core/discovery",
    "@junejs/core/cache",
    "@junejs/core/instrumentation",
  ];

  for (const spec of subpaths) {
    test(`import.meta.resolve("${spec}") resolves to a @junejs/core source file`, () => {
      const resolved = import.meta.resolve(spec);
      expect(resolved).toContain("/core/src/");
      expect(resolved).toMatch(/\.tsx?$/);
    });
  }
});
