// The auto island registry generator: scans "use client" island() modules and
// emits app/_islands.gen.ts keyed by export name → lazy import. Legacy islands
// (no island() from poc-islands) and non-client modules are excluded.
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
  `"use client";\nimport { island } from "@junejs/core/poc-islands";\nexport const ${name} = island(function ${name}(){ return null; });\n`;

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

  test("excludes legacy islands (no island() from poc-islands) and server modules", () => {
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
});
