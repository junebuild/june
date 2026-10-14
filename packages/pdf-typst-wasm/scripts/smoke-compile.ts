// The package inside a `bun build --compile` binary (#367): test/compile/main.ts, compiled
// with no `wasm` option, run from another directory so nothing on disk can stand in for the
// embedded module. Bun tests run from source and can't see what the bundler embeds; only this
// run does. Needs dist/typst.wasm (bun run build).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "pdf-typst-wasm-compile-"));
try {
  const bin = join(out, "app");
  const build = spawnSync("bun", ["build", "--compile", "test/compile/main.ts", "--outfile", bin], { cwd: PKG, encoding: "utf8" });
  assert.equal(build.status, 0, `bun build --compile failed:\n${build.stdout}${build.stderr}`);
  const run = spawnSync(bin, [], { cwd: out, encoding: "utf8" });
  assert.equal(run.status, 0, `the binary failed: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /^%PDF- \d+/, run.stdout);
  console.log(`pdf-typst-wasm compile smoke: OK (${run.stdout.trim()})`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
