// The package inside `bun build --compile` binaries, run from another directory so nothing on
// disk can stand in for an embedded file. Bun tests run from source and can't see what the
// bundler embeds; only this run does. Needs dist/typst.wasm and its ref (bun run build).
//   • test/compile/main.ts, the default entry with no `wasm` option: the engine is embedded
//     (#367).
//   • test/compile/unbundled.ts: the engine is not embedded, the binary is the size of the Bun
//     runtime, and it renders with the engine loaded from outside (#383).

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "pdf-typst-wasm-compile-"));
const MiB = 1048576;
const compile = (entry: string, name: string): { bin: string; mib: number } => {
  const bin = join(out, name);
  const build = spawnSync("bun", ["build", "--compile", entry, "--outfile", bin], { cwd: PKG, encoding: "utf8" });
  assert.equal(build.status, 0, `bun build --compile ${entry} failed:\n${build.stdout}${build.stderr}`);
  return { bin, mib: statSync(bin).size / MiB };
};
const run = (bin: string, env: Record<string, string> = {}) => {
  const r = spawnSync(bin, [], { cwd: out, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `${bin} failed: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^%PDF- \d+/, r.stdout);
  return r.stdout.trim();
};
try {
  const engineMiB = statSync(join(PKG, "dist/typst.wasm")).size / MiB;
  // The Bun runtime alone, to measure the others against: its size varies by platform.
  const empty = join(out, "empty.ts");
  spawnSync("sh", ["-c", `echo 'console.log(1)' > ${empty}`]);
  const runtime = compile(empty, "empty");

  const bundled = compile("test/compile/main.ts", "app");
  const bundledOut = run(bundled.bin);
  assert.ok(bundled.mib - runtime.mib > engineMiB * 0.9, `the default entry embeds the engine: ${bundled.mib.toFixed(1)} MiB vs ${runtime.mib.toFixed(1)} MiB runtime`);

  const unbundled = compile("test/compile/unbundled.ts", "unbundled");
  assert.ok(unbundled.mib - runtime.mib < 5, `the unbundled entry embeds no engine: ${unbundled.mib.toFixed(1)} MiB vs ${runtime.mib.toFixed(1)} MiB runtime`);
  const engine = join(out, "cache-typst.wasm"); // outside the binary, as a cache would hold it
  copyFileSync(join(PKG, "dist/typst.wasm"), engine);
  const unbundledOut = run(unbundled.bin, { JUNE_TYPST_WASM: engine });

  console.log(
    `pdf-typst-wasm compile smoke: OK (runtime ${runtime.mib.toFixed(1)} MiB; default entry ${bundled.mib.toFixed(1)} MiB, ${bundledOut}; ` +
      `unbundled ${unbundled.mib.toFixed(1)} MiB, ${unbundledOut})`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
