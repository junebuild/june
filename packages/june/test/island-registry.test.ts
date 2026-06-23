// The usage-driven island registry generator: scans `<X client:*/>` usages and
// resolves each component's import AT THE USAGE SITE (app or lib alike).
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { generateIslandRegistry, ISLAND_REGISTRY_FILE } from "../src/island-registry";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function appDir(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "june-isl-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, src);
  }
  return dir;
}
const gen = (app: string) => readFileSync(join(app, ISLAND_REGISTRY_FILE), "utf8");

describe("generateIslandRegistry (usage-driven)", () => {
  test("emits a loader per island usage, keyed by imported name", () => {
    const app = appDir({
      "page.tsx":
        'import { Counter } from "./Counter";\n' +
        "export default function P(){ return <main><Counter initial={0} client:load /></main>; }\n",
    });
    expect(generateIslandRegistry(app)).toBe(1);
    expect(gen(app)).toContain('"Counter": () => import("./Counter").then((m) => m.Counter)');
  });

  test("a lib (package) island is discovered the same way — no manifest", () => {
    const app = appDir({
      "page.tsx":
        'import { ApiExplorer } from "kuradocs";\n' +
        "export default function P(){ return <ApiExplorer client:visible />; }\n",
    });
    expect(generateIslandRegistry(app)).toBe(1);
    expect(gen(app)).toContain('"ApiExplorer": () => import("kuradocs").then((m) => m.ApiExplorer)');
  });

  test("re-bases a relative specifier from a nested page to the app dir", () => {
    const app = appDir({
      "docs/page.tsx":
        'import { Widget } from "../Widget";\n' +
        "export default function P(){ return <Widget client:load />; }\n",
    });
    generateIslandRegistry(app);
    expect(gen(app)).toContain('"Widget": () => import("./Widget").then((m) => m.Widget)');
  });

  test("a component WITHOUT client:* is not an island", () => {
    const app = appDir({
      "page.tsx":
        'import { Counter } from "./Counter";\n' +
        "export default function P(){ return <Counter initial={0} />; }\n",
    });
    expect(generateIslandRegistry(app)).toBe(0);
  });

  test("the same island used on several pages → one loader", () => {
    const app = appDir({
      "page.tsx": 'import { Counter } from "./Counter";\nexport default () => <Counter client:load />;\n',
      "about/page.tsx": 'import { Counter } from "../Counter";\nexport default () => <Counter client:idle />;\n',
    });
    expect(generateIslandRegistry(app)).toBe(1);
  });

  test("throws on a duplicate island name from different modules", () => {
    const app = appDir({
      "a/page.tsx": 'import { Counter } from "../x/Counter";\nexport default () => <Counter client:load />;\n',
      "b/page.tsx": 'import { Counter } from "../y/Counter";\nexport default () => <Counter client:load />;\n',
    });
    expect(() => generateIslandRegistry(app)).toThrow(/duplicate island name "Counter"/);
  });

  test("throws on a local (non-imported) component used as an island", () => {
    const app = appDir({
      "page.tsx":
        "function Local(){ return null; }\nexport default () => <Local client:load />;\n",
    });
    expect(() => generateIslandRegistry(app)).toThrow(/must be an IMPORTED component/);
  });

  test("throws on a default import used as an island", () => {
    const app = appDir({
      "page.tsx": 'import Counter from "./Counter";\nexport default () => <Counter client:load />;\n',
    });
    expect(() => generateIslandRegistry(app)).toThrow(/NAMED imports/);
  });

  test("a slot island (used with children) still emits one loader — slot is runtime", () => {
    const app = appDir({
      "Tabs.tsx": '"use client";\nexport function Tabs(){ return null; }\n',
      "page.tsx": 'import { Tabs } from "./Tabs";\nexport default () => <Tabs client:visible><p>panel</p></Tabs>;\n',
    });
    expect(generateIslandRegistry(app)).toBe(1);
    expect(gen(app)).toContain('"Tabs": () => import("./Tabs").then((m) => m.Tabs)');
  });

  test('N3: throws when a resolvable island module is not "use client"', () => {
    const app = appDir({
      "Counter.tsx": "export function Counter(){ return null; }\n", // no "use client"
      "page.tsx": 'import { Counter } from "./Counter";\nexport default () => <Counter client:load />;\n',
    });
    expect(() => generateIslandRegistry(app)).toThrow(/not "use client"/);
  });

  test('N3: accepts a relative island module that is "use client"', () => {
    const app = appDir({
      "Counter.tsx": '"use client";\nexport function Counter(){ return null; }\n',
      "page.tsx": 'import { Counter } from "./Counter";\nexport default () => <Counter client:load />;\n',
    });
    expect(generateIslandRegistry(app)).toBe(1);
  });
});
