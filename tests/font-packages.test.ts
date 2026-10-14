// The Noto Sans CJK font packages are generated (scripts/font-package/generate.ts, #381): this
// fails when one has drifted from the template and its table, naming the files and the fix.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expected, SPECS } from "../scripts/font-package/generate";

const ROOT = join(import.meta.dir, "..");

describe("font packages", () => {
  test("each package is what the generator writes (run `bun scripts/font-package/generate.ts`)", () => {
    const differing = [...expected()].filter(([rel, text]) => !existsSync(join(ROOT, rel)) || readFileSync(join(ROOT, rel), "utf8") !== text).map(([rel]) => rel);
    expect(differing).toEqual([]);
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
});
