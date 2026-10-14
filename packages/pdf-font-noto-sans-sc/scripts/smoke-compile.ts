// The package inside `bun build --compile` binaries, run from another directory so nothing on
// disk can stand in for an embedded file. Needs fonts/ (scripts/fetch-fonts.ts) and the engine
// and its ref (packages/pdf-typst-wasm: bun run build). CI's pdf-engine job runs it for TC
// only: every CJK package's loading code is generated from one template.
//   • test/compile/main.ts, the default entries: engine and fonts embedded.
//   • test/compile/unbundled.ts: neither embedded, so the binary stays near the runtime's size,
//     and both load from a directory outside it (#383).
//   • test/compile/cached.ts: the same, through @junejs/server's assetCache — the first run
//     downloads all three files from a local mirror into an empty directory and checks them,
//     the second runs offline with the mirror gone (#383).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "pdf-font-noto-sans-sc-compile-"));
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
  assert.match(r.stdout, /NotoSansSC-Regular/, r.stdout);
  assert.match(r.stdout, /NotoSansSC-Bold/, r.stdout);
};
// Async, so the mirror served from this process can answer while the binary runs.
const runAsync = (bin: string, env: Record<string, string>) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(bin, [], { cwd: out, env: { ...process.env, ...env } });
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${bin} failed: ${text}`));
      if (!/NotoSansSC-Regular/.test(text) || !/NotoSansSC-Bold/.test(text)) return reject(new Error(`${bin}: ${text}`));
      resolve();
    });
  });
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
  for (const f of ["NotoSansSC-Regular.otf", "NotoSansSC-Bold.otf"]) copyFileSync(join(PKG, "fonts", f), join(assets, f));
  run(unbundled.bin, { JUNE_ASSETS: assets });

  // First use downloads, then offline: a mirror on localhost stands in for the CDNs.
  const cached = compile("test/compile/cached.ts", "cached");
  assert.ok(cached.mib - runtime.mib < 5, `assetCache adds no files to the binary: ${cached.mib.toFixed(1)} MiB vs ${runtime.mib.toFixed(1)} MiB runtime`);
  const files: Record<string, string> = { "typst.wasm": join(PKG, "../pdf-typst-wasm/dist/typst.wasm"), "NotoSansSC-Regular.otf": join(PKG, "fonts/NotoSansSC-Regular.otf"), "NotoSansSC-Bold.otf": join(PKG, "fonts/NotoSansSC-Bold.otf") };
  const served: string[] = [];
  const mirror = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      served.push(name);
      return files[name] ? new Response(Bun.file(files[name]!)) : new Response("not found", { status: 404 });
    },
  });
  const cacheDir = join(out, "cache");
  mkdirSync(cacheDir);
  try {
    await runAsync(cached.bin, { JUNE_ASSETS: cacheDir, JUNE_MIRROR: `http://127.0.0.1:${mirror.port}` });
  } finally {
    mirror.stop(true);
  }
  assert.deepEqual(served.sort(), Object.keys(files).sort(), "the first run fetched each file once");
  await runAsync(cached.bin, { JUNE_ASSETS: cacheDir }); // offline, the mirror gone

  console.log(
    `pdf-font-noto-sans-sc compile smoke: OK (runtime ${runtime.mib.toFixed(1)} MiB; default entries ${bundled.mib.toFixed(1)} MiB; unbundled ${unbundled.mib.toFixed(1)} MiB; ` +
      `assetCache ${cached.mib.toFixed(1)} MiB, downloaded ${served.length} files then rendered offline; all render regular and bold)`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
