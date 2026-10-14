// The package inside a `bun build --compile` binary: test/compile/main.ts, run from another
// directory so nothing on disk can stand in for the embedded files. Needs fonts/
// (scripts/fetch-fonts.ts) and the engine (packages/pdf-typst-wasm: bun run build).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "pdf-font-noto-sans-tc-compile-"));
try {
  const bin = join(out, "app");
  const build = spawnSync("bun", ["build", "--compile", "test/compile/main.ts", "--outfile", bin], { cwd: PKG, encoding: "utf8" });
  assert.equal(build.status, 0, `bun build --compile failed:\n${build.stdout}${build.stderr}`);
  const run = spawnSync(bin, [], { cwd: out, encoding: "utf8" });
  assert.equal(run.status, 0, `the binary failed: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /NotoSansTC-Regular/, run.stdout);
  assert.match(run.stdout, /NotoSansTC-Bold/, run.stdout);
  console.log("pdf-font-noto-sans-tc compile smoke: OK (regular and bold embedded in the binary)");
} finally {
  rmSync(out, { recursive: true, force: true });
}
