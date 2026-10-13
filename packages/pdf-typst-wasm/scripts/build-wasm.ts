// Build dist/typst.wasm, the module the package ships: cargo (wasm32-unknown-unknown,
// release, the locked dependency graph, the toolchain rust-toolchain.toml pins), then
// binaryen's wasm-opt -Oz. Run by `bun run build` (so by publish.yml) and by CI's engine job;
// tests that need the module skip with a pointer here when dist/typst.wasm is missing.
//
// Requires: rustup (it installs the pinned toolchain and target on first use) and wasm-opt
// on PATH (binaryen; CI pins its version).

import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(pkg, "target/wasm32-unknown-unknown/release/june_pdf_typst_wasm.wasm");
const out = join(pkg, "dist/typst.wasm");

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: pkg, stdio: "inherit" });
  if (r.error) throw new Error(`${cmd}: ${r.error.message} — is it installed and on PATH?`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

run("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown"]);
mkdirSync(dirname(out), { recursive: true });
// The features rustc's default wasm32 target emits; wasm-opt must be told to accept them.
run("wasm-opt", [
  "-Oz",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--strip-debug",
  "--strip-producers",
  built,
  "-o",
  out,
]);
console.log(`dist/typst.wasm: ${(statSync(out).size / 1048576).toFixed(1)} MiB`);
