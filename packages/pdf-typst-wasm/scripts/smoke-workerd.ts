// Proves @junejs/pdf-typst-wasm on workerd, as an app gets it: the published dist (the
// `workerd` export condition → dist/workerd.js importing dist/typst.wasm), bundled and
// served by `wrangler dev --local`, rendering over real HTTP. Bun tests use the Node entry;
// only this run shows the module import, the precompiled upload path and the engine inside
// a Worker isolate work.
//
// Run: bun scripts/smoke-workerd.ts  (from packages/pdf-typst-wasm; CI: the pdf-engine job).
// Builds the module first unless SMOKE_SKIP_BUILD=1 (CI built it in an earlier step).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_WORKERD_PORT ?? 8798);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// The pinned wrangler the repo's own workerd smoke and `june deploy` run.
const WRANGLER = "wrangler@4.99.0";

const step = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed`);
};
// The dist an app installs: this package (engine + JS) and @junejs/pdf, which it imports.
if (process.env.SMOKE_SKIP_BUILD !== "1") step("bun", ["run", "build"], PKG);
else step("bunx", ["tsdown"], PKG);
step("bunx", ["tsdown"], join(PKG, "../pdf"));

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

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ORIGIN}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
}

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
const pageCount = (pdf: Uint8Array) => Number(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(latin1.decode(pdf))?.[1] ?? NaN);

try {
  await ready();
  // Three renders in a row: the engine created by the first serves the next two.
  for (let i = 1; i <= 3; i++) {
    const res = await request("/");
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(res.status, 200, `render ${i}: ${latin1.decode(body)}`);
    assert.equal(latin1.decode(body.slice(0, 5)), "%PDF-", `render ${i} is a PDF`);
    assert.equal(pageCount(body), 1);
  }
  const long = Array.from({ length: 80 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of the report.`).join("\n\n");
  const paged = new Uint8Array(await (await request("/", { method: "POST", body: long })).arrayBuffer());
  assert.ok(pageCount(paged) > 3, "a long document paginates");
  const tool = await request("/tool");
  assert.equal(tool.status, 200);
  assert.equal(tool.headers.get("x-filename"), "From the tool.pdf");
  console.log("pdf-typst-wasm workerd smoke: OK (module import, repeated renders, pagination, render_pdf)");
} catch (err) {
  console.error(`pdf-typst-wasm workerd smoke FAILED\n--- wrangler log ---\n${log}`);
  throw err;
} finally {
  stop();
}
