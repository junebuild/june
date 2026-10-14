// The Noto Sans CJK font packages are generated (scripts/font-package/generate.ts, #381): this
// fails when one has drifted from the template and its table, naming the files and the fix.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expected, releaseOwned, SPECS, stale } from "../scripts/font-package/generate";

const ROOT = join(import.meta.dir, "..");

describe("font packages", () => {
  test("each package is what the generator writes (run `bun scripts/font-package/generate.ts`)", () => {
    const differing = [...expected()].filter(([rel, text]) => !existsSync(join(ROOT, rel)) || readFileSync(join(ROOT, rel), "utf8") !== text).map(([rel]) => rel);
    expect(differing).toEqual([]);
  });

  test("no package holds a file the generator no longer writes", () => {
    expect(stale()).toEqual([]);
    // A file left behind by a removed template file is found.
    const stray = join(ROOT, "packages/pdf-font-noto-sans-tc/src/removed.ts");
    writeFileSync(stray, "export {};\n");
    try {
      expect(stale()).toEqual(["packages/pdf-font-noto-sans-tc/src/removed.ts"]);
    } finally {
      rmSync(stray);
    }
    // Local state git ignores (wrangler's cache) is not output, and is never listed.
    const local = join(ROOT, "packages/pdf-font-noto-sans-tc/test/workerd/.wrangler/probe");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "x");
    try {
      expect(stale()).toEqual([]);
    } finally {
      rmSync(local);
    }
  });

  test("every generated package is published and released with the others", () => {
    const publish = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");
    const packed = readFileSync(join(ROOT, "scripts/smoke-packed.sh"), "utf8");
    const fixed = (JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8")) as { fixed: string[][] }).fixed.flat();
    for (const { code } of SPECS) {
      expect(publish).toContain(`pdf-font-noto-sans-${code}`);
      expect(packed).toContain(`pdf-font-noto-sans-${code}`);
      expect(fixed).toContain(`@junejs/pdf-font-noto-sans-${code}`);
    }
  });

  test("a release's version and @junejs ranges are kept, so a Version Packages PR doesn't fail the drift check", () => {
    const rendered = JSON.stringify({ name: "x", version: "0.0.0", peerDependencies: { "@junejs/pdf-typst-wasm": "^0.2.0" }, devDependencies: { "@junejs/pdf": "^0.2.0", typescript: "^5" } }, null, 2) + "\n";
    // What changesets leaves behind after bumping the fixed group to 0.2.1.
    const released = JSON.stringify({ name: "x", version: "0.2.1", peerDependencies: { "@junejs/pdf-typst-wasm": "^0.2.1" }, devDependencies: { "@junejs/pdf": "^0.2.1", typescript: "^4" } }, null, 2) + "\n";
    const out = JSON.parse(releaseOwned(rendered, released, "0.2.0"));
    expect(out.version).toBe("0.2.1");
    expect(out.peerDependencies).toEqual({ "@junejs/pdf-typst-wasm": "^0.2.1" });
    expect(out.devDependencies).toEqual({ "@junejs/pdf": "^0.2.1", typescript: "^5" }); // only @junejs ranges belong to the release
    // A new package: the shared version, the template's ranges.
    expect(JSON.parse(releaseOwned(rendered, undefined, "0.2.0"))).toMatchObject({ version: "0.2.0", peerDependencies: { "@junejs/pdf-typst-wasm": "^0.2.0" } });
  });
});
