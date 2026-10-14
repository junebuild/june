// The package on Node, the way an npm user gets it, on plain `node` from another directory:
// test/node/main.mjs on the default entry (dist/node.js reading ../fonts/*.otf), and
// test/node/unbundled.mjs on both packages' unbundled entries (#383). Bun tests resolve
// the Bun entry and the other smokes cover Bun and workerd; only this run covers Node.
//
// Needs node on PATH (CI: Node 24), the engine built (packages/pdf-typst-wasm: bun run build)
// and fonts/ fetched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const step = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed`);
};
// The dist an app installs: this package, the renderer and @junejs/pdf, which it imports.
step("bun", ["scripts/fetch-fonts.ts"], PKG);
for (const dir of [PKG, join(PKG, "../pdf-typst-wasm"), join(PKG, "../pdf")]) step("bunx", ["tsdown"], dir);

for (const [script, entry] of [["main.mjs", "node.js"], ["unbundled.mjs", "unbundled.js"]]) {
  const run = spawnSync("node", [join(PKG, "test/node", script)], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(run.status, 0, `node ${script} failed: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, new RegExp(`/dist/${entry.replace(".", "\\.")}\n`), `resolved the published entry: ${run.stdout}`);
  assert.match(run.stdout, /NotoSansJP-Regular/, run.stdout);
  assert.match(run.stdout, /NotoSansJP-Bold/, run.stdout);
}
console.log(`pdf-font-noto-sans-jp node smoke: OK (dist/node.js and the unbundled entries' dist, regular and bold embedded)`);
