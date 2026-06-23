// The auto island registry generator: scans "use client" island() modules and
// emits app/_islands.gen.ts keyed by export name → lazy import. Legacy islands
// (no island() from islands) and non-client modules are excluded.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateIslandRegistry, ISLAND_REGISTRY_FILE } from "../src/island-registry";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function appDir(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "june-islands-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, src);
  }
  return dir;
}

const ISLAND = (name: string) =>
  `"use client";\nimport { island } from "@junejs/core/islands";\nexport const ${name} = island(function ${name}(){ return null; });\n`;

describe("generateIslandRegistry", () => {
  test("emits a lazy loader per island export, keyed by export name", () => {
    const app = appDir({
      "poc/Counter.tsx": ISLAND("Counter"),
      "widgets/Tabs.tsx": ISLAND("Tabs"),
    });
    const n = generateIslandRegistry(app);
    const out = readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");

    expect(n).toBe(2);
    expect(out).toContain('"Counter": () => import("./poc/Counter")');
    expect(out).toContain('"Tabs": () => import("./widgets/Tabs")');
    expect(out).toContain("export const ISLAND_LOADERS");
  });

  test("excludes legacy islands (no island() from islands) and server modules", () => {
    const app = appDir({
      // legacy: "use client" but uses the OLD <Island> path, no island() wrapper
      "Legacy.tsx": `"use client";\nimport { useState } from "react";\nexport function Legacy(){ const [n]=useState(0); return null; }\n`,
      // a plain server component
      "page.tsx": `export default function Page(){ return null; }\n`,
      // a real island
      "Real.tsx": ISLAND("Real"),
    });
    const n = generateIslandRegistry(app);
    const out = readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");

    expect(n).toBe(1);
    expect(out).toContain('"Real": () => import("./Real")');
    expect(out).not.toContain("Legacy");
    expect(out).not.toContain("Page");
  });

  test("emits a valid empty registry when there are no islands", () => {
    const app = appDir({ "page.tsx": `export default function P(){ return null; }\n` });
    const n = generateIslandRegistry(app);
    const out = readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");
    expect(n).toBe(0);
    expect(out).toContain("export const ISLAND_LOADERS: Record<string, () => Promise<unknown>> = {\n};");
  });

  // P1-1: key by the ISLAND name (from the call), not the export name — so an
  // export/function-name mismatch can't silently fail to hydrate.
  test("keys by the island name even when it differs from the export name", () => {
    const app = appDir({
      "Counter.tsx":
        '"use client";\nimport { island } from "@junejs/core/islands";\n' +
        'export const Widget = island(function Counter(){ return null; });\n',
    });
    generateIslandRegistry(app);
    const out = readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");
    expect(out).toContain('"Counter": () => import("./Counter")'); // the island name, not "Widget"
    expect(out).not.toContain("Widget");
  });

  // P1-1: explicit { name } wins.
  test("honors an explicit { name } option", () => {
    const app = appDir({
      "C.tsx":
        '"use client";\nimport { island } from "@junejs/core/islands";\n' +
        'export const C = island(function Impl(){ return null; }, { name: "Picked" });\n',
    });
    generateIslandRegistry(app);
    const out = readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");
    expect(out).toContain('"Picked": () => import("./C")');
  });

  // P1-2: a multi-line island() declaration the old line-regex would have missed.
  test("handles a multi-line island() declaration (AST, not line regex)", () => {
    const app = appDir({
      "Multi.tsx":
        '"use client";\nimport { island } from "@junejs/core/islands";\n' +
        "export const Multi = island(\n  function Multi() {\n    return null;\n  },\n  { strategy: \"visible\" },\n);\n",
    });
    const n = generateIslandRegistry(app);
    const out = readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");
    expect(n).toBe(1);
    expect(out).toContain('"Multi": () => import("./Multi")');
  });

  // P2-1: a duplicate island name across modules is a build error, not a silent
  // overwrite.
  test("throws on a duplicate island name across modules", () => {
    const app = appDir({ "a/Dup.tsx": ISLAND("Dup"), "b/Dup.tsx": ISLAND("Dup") });
    expect(() => generateIslandRegistry(app)).toThrow(/duplicate island name "Dup"/);
  });
});
