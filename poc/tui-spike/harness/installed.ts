// The install paths (docs/rfc-tui.md §5): pack the spike, install the tarball
// the way a user would, and run the harness against the bin that install made
// — so the native core has to resolve from an installed copy, not from this
// checkout. `june inbox` delegation is not covered: the external-subcommand
// lookup does not exist yet.
//
//   bun harness/installed.ts <path> [--out results.json]
//
//   npm         npm install <tgz> in a fresh project, run node_modules/.bin
//   bun         bun add <tgz> in a fresh project, run node_modules/.bin
//   npm-global  npm install -g --prefix <tmp> <tgz>, run the global bin
//   bun-global  bun add -g <tgz> with BUN_INSTALL_{GLOBAL_DIR,BIN} in <tmp>
//   bunx        bun x -p <tgz> tui-spike (installs into bunx's cache)

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const paths = ["npm", "bun", "npm-global", "bun-global", "bunx"] as const;
const path = process.argv[2] as (typeof paths)[number];
if (!paths.includes(path)) throw new Error(`usage: bun harness/installed.ts ${paths.join("|")} [--out file]`);
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

function run(argv: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(argv, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${p.exitCode}`);
}

// The shim a package manager wrote into dir: npm writes .cmd on Windows, bun .exe.
function shim(dir: string): string[] {
  const bin = isWin
    ? ["tui-spike.exe", "tui-spike.cmd"].map((f) => join(dir, f)).find((p) => existsSync(p))
    : join(dir, "tui-spike");
  if (!bin || !existsSync(bin)) throw new Error(`no tui-spike shim in ${dir}`);
  // A .cmd shim needs cmd.exe to run it.
  return bin.endsWith(".cmd") ? ["cmd.exe", "/d", "/c", bin] : [bin];
}

const packDir = mkdtempSync(join(tmpdir(), "tui-spike-pack-"));
run([process.execPath, "pm", "pack", "--destination", packDir], root);
const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz"))!);
const tmp = mkdtempSync(join(tmpdir(), `tui-spike-${path}-`));
const env: Record<string, string> = {};

let cmd: string[];
switch (path) {
  case "npm":
  case "bun": {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "fresh-app", private: true, type: "module" }));
    if (path === "npm") run([npm, "install", "--no-audit", "--no-fund", tarball], tmp);
    else run([process.execPath, "add", tarball], tmp);
    cmd = shim(join(tmp, "node_modules", ".bin"));
    break;
  }
  case "npm-global": {
    run([npm, "install", "-g", "--prefix", tmp, "--no-audit", "--no-fund", tarball], tmp);
    // npm puts global bins in <prefix>/bin on POSIX and in <prefix> itself on Windows.
    cmd = shim(isWin ? tmp : join(tmp, "bin"));
    break;
  }
  case "bun-global": {
    env.BUN_INSTALL_GLOBAL_DIR = join(tmp, "global");
    env.BUN_INSTALL_BIN = join(tmp, "bin");
    run([process.execPath, "add", "-g", tarball], tmp, env);
    cmd = shim(env.BUN_INSTALL_BIN);
    break;
  }
  case "bunx": {
    // The first run installs into bunx's cache; warm it off-terminal so the
    // harness's first scenario measures the TUI, not the download.
    cmd = [process.execPath, "x", "-p", tarball, "tui-spike"];
    const warm = Bun.spawnSync(cmd, { cwd: tmp, stdio: ["ignore", "pipe", "inherit"] });
    if (warm.exitCode !== 0) throw new Error(`bunx warm-up exited ${warm.exitCode}`);
    break;
  }
}
console.log(`installed via ${path}: ${cmd.join(" ")}`);

const out = process.argv.indexOf("--out");
const harness = Bun.spawnSync(
  [process.execPath, join(root, "harness/run.ts"), "--cmd", JSON.stringify(cmd), ...(out > 0 ? ["--out", process.argv[out + 1]!] : [])],
  { cwd: root, env: { ...process.env, ...env }, stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(harness.exitCode ?? 1);
