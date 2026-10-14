// Proves @junejs/pdf-font-noto-sans-jp on workerd, as an app gets it: the published dist (the
// `workerd` export condition → dist/workerd.js importing ../fonts/*.otf as Data modules) with
// @junejs/pdf-typst-wasm's dist, served by `wrangler dev --local`. Only this run shows the fonts
// upload with the Worker and fit next to the engine.
//
// Run: bun scripts/smoke-workerd.ts  (from packages/pdf-font-noto-sans-jp; CI: the pdf-engine
// job). Needs the engine built (packages/pdf-typst-wasm: bun run build) and fonts/ fetched.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_WORKERD_PORT ?? 8799);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// The pinned wrangler the repo's other workerd smokes and `june deploy` run.
const WRANGLER = "wrangler@4.99.0";

const step = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed`);
};
// The dist an app installs: this package, the renderer and @junejs/pdf, which it imports.
step("bun", ["scripts/fetch-fonts.ts"], PKG);
for (const dir of [PKG, join(PKG, "../pdf-typst-wasm"), join(PKG, "../pdf")]) step("bunx", ["tsdown"], dir);

// detached → its own process group, so teardown reaches the workerd child too.
const wrangler = spawn("bunx", [WRANGLER, "dev", "--config", "test/workerd/wrangler.jsonc", "--local", "--ip", "127.0.0.1", "--port", String(PORT)], {
  cwd: PKG,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));
const exited = () => wrangler.exitCode !== null || wrangler.signalCode !== null;
const stop = () => {
  try {
    process.kill(-wrangler.pid!, "SIGTERM");
  } catch {
    /* already gone */
  }
};

const request = (path: string, init?: RequestInit) => fetch(`${ORIGIN}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });

async function ready(timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited()) throw new Error(`wrangler exited before it was ready\n${log}`);
    try {
      await request("/", { method: "HEAD" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`workerd not ready on ${ORIGIN} within ${timeoutMs}ms\n${log}`);
}

const latin1 = new TextDecoder("latin1");
const embedded = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

try {
  await ready();
  // Repeated renders: the fonts are registered once and serve each document.
  for (let i = 1; i <= 3; i++) {
    const res = await request("/");
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(res.status, 200, `render ${i}: ${latin1.decode(body)}`);
    assert.deepEqual(["NotoSansJP-Bold", "NotoSansJP-Regular"].filter((f) => embedded(body).includes(f)), ["NotoSansJP-Bold", "NotoSansJP-Regular"], `render ${i} embeds both weights`);
  }
  const rare = await request("/", { method: "POST", body: "難読：靐" });
  assert.equal(rare.status, 500);
  assert.match(await rare.text(), /covers 靐/);
  console.log("pdf-font-noto-sans-jp workerd smoke: OK (Data module fonts, repeated renders, missing glyphs)");
} catch (err) {
  console.error(`pdf-font-noto-sans-jp workerd smoke FAILED\n--- wrangler log ---\n${log}`);
  throw err;
} finally {
  stop();
}
