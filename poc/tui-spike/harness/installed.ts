// The install path (docs/rfc-tui.md §5): pack the spike, install the tarball
// into a fresh project with npm or bun, and run the harness against the bin
// the package manager created — so the native core has to resolve from a
// user's node_modules, not from this checkout.
//
//   bun harness/installed.ts npm|bun [--out results.json]

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pm = process.argv[2];
if (pm !== "npm" && pm !== "bun") throw new Error("usage: bun harness/installed.ts npm|bun [--out file]");
const isWin = process.platform === "win32";

function run(argv: string[], cwd: string) {
  const p = Bun.spawnSync(argv, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${p.exitCode}`);
}

const packDir = mkdtempSync(join(tmpdir(), "tui-spike-pack-"));
run([process.execPath, "pm", "pack", "--destination", packDir], root);
const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz"))!);

const app = mkdtempSync(join(tmpdir(), "tui-spike-app-"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "fresh-app", private: true, type: "module" }));
if (pm === "npm") run([isWin ? "npm.cmd" : "npm", "install", "--no-audit", "--no-fund", tarball], app);
else run([process.execPath, "add", tarball], app);

// On Windows, npm writes a .cmd shim and bun an .exe one.
const binDir = join(app, "node_modules", ".bin");
const bin = isWin
  ? ["tui-spike.exe", "tui-spike.cmd"].map((f) => join(binDir, f)).find((p) => existsSync(p))!
  : join(binDir, "tui-spike");
if (!bin) throw new Error(`no tui-spike shim in ${binDir}`);
// A .cmd shim needs cmd.exe to run it.
const cmd = bin.endsWith(".cmd") ? ["cmd.exe", "/d", "/c", bin] : [bin];
console.log(`installed with ${pm}: ${bin}`);

const out = process.argv.indexOf("--out");
const harness = Bun.spawnSync(
  [process.execPath, join(root, "harness/run.ts"), "--cmd", JSON.stringify(cmd), ...(out > 0 ? ["--out", process.argv[out + 1]!] : [])],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(harness.exitCode ?? 1);
