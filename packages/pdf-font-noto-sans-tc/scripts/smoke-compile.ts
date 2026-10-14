// The package inside `bun build --compile` binaries, run from another directory so nothing on
// disk can stand in for an embedded file. Needs fonts/ (scripts/fetch-fonts.ts) and the engine
// and its ref (packages/pdf-typst-wasm: bun run build).
//   • test/compile/main.ts, the default entries: engine and fonts embedded.
//   • test/compile/unbundled.ts: neither embedded, so the binary stays near the runtime's size,
//     and both load from a directory outside it (#383).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "pdf-font-noto-sans-tc-compile-"));
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
  assert.match(r.stdout, /NotoSansTC-Regular/, r.stdout);
  assert.match(r.stdout, /NotoSansTC-Bold/, r.stdout);
};
try {
  const empty = join(out, "empty.ts");
  writeFileSync(empty, "console.log(1);\n");
  const runtime = compile(empty, "empty");

  const bundled = compile("test/compile/main.ts", "app");
  run(bundled.bin);

  const unbundled = compile("test/compile/unbundled.ts", "unbundled");
  assert.ok(unbundled.mib - runtime.mib < 5, `the unbundled entries embed no engine or font: ${unbundled.mib.toFixed(1)} MiB vs ${runtime.mib.toFixed(1)} MiB runtime`);
  const assets = join(out, "assets"); // outside the binary, as a cache on a volume would be
  mkdirSync(assets);
  copyFileSync(join(PKG, "../pdf-typst-wasm/dist/typst.wasm"), join(assets, "typst.wasm"));
  for (const f of ["NotoSansTC-Regular.otf", "NotoSansTC-Bold.otf"]) copyFileSync(join(PKG, "fonts", f), join(assets, f));
  run(unbundled.bin, { JUNE_ASSETS: assets });

  console.log(`pdf-font-noto-sans-tc compile smoke: OK (runtime ${runtime.mib.toFixed(1)} MiB; default entries ${bundled.mib.toFixed(1)} MiB; unbundled ${unbundled.mib.toFixed(1)} MiB; both render regular and bold)`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
