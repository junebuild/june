// Proves the BUILT worker end-to-end on workerd — the runtime production runs,
// not the Bun dev host. `june build` examples/basic (assets + run_worker_first,
// the deployed shape), serve dist/ with `wrangler dev --local`, and exercise it
// over real HTTP.
//
// Why a separate smoke: the dev host has no ASSETS binding and isn't workerd, so
// a whole class of bug only exists after deploy. withAssets once handed every
// POST to ASSETS.fetch(), which drains the body on workerd — POST /mcp answered
// -32700 on every deployed app for three months while every Bun test passed
// (#198). This run would have failed on it.
//
// Run: bun scripts/smoke-workerd.ts   (CI: the `workerd` job)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = "examples/basic";
const PORT = Number(process.env.SMOKE_WORKERD_PORT ?? 8799);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// The same pinned wrangler `june deploy` runs (packages/june/src/deploy.ts).
const WRANGLER = "wrangler@4.99.0";

// 1. Build the deployable bundle, exactly as `june deploy` would.
const build = spawnSync("bun", ["packages/cli/src/june.ts", "build", APP], { cwd: ROOT, stdio: "inherit" });
assert.equal(build.status, 0, "june build failed");

// 2. Serve it on workerd. detached → its own process group, so teardown also
//    reaches the workerd child wrangler spawns (killing wrangler alone leaves
//    workerd holding the port).
const wrangler = spawn(
  "bunx",
  [WRANGLER, "dev", "--config", `${APP}/dist/wrangler.jsonc`, "--local", "--ip", "127.0.0.1", "--port", String(PORT)],
  { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));
// Dead either way: a normal exit sets exitCode, a signal (crash, OOM kill) leaves
// exitCode null and sets signalCode — the same check packages/cli/src/watch.ts uses.
const exited = () => wrangler.exitCode !== null || wrangler.signalCode !== null;
const exitStatus = () => wrangler.signalCode ?? `exit ${wrangler.exitCode}`;
// Every request is bounded: a workerd that accepts the connection but never
// answers must fail the smoke, not hang the CI job.
const REQUEST_TIMEOUT_MS = 15_000;
const http = (path: string, init: RequestInit = {}) =>
  fetch(ORIGIN + path, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
const stop = () => {
  try {
    process.kill(-wrangler.pid!, "SIGTERM");
  } catch {
    /* already gone */
  }
};

async function ready(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited()) throw new Error(`wrangler exited before it was ready (${exitStatus()})\n${log}`);
    try {
      if ((await http("/", { signal: AbortSignal.timeout(5_000) })).status < 500) return;
    } catch {
      /* not listening yet (or this probe timed out) — retry until the deadline */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`workerd not ready on ${ORIGIN} within ${timeoutMs}ms\n${log}`);
}

const rpc = async (body: unknown) => {
  const res = await http("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `POST /mcp → ${res.status}`);
  return (await res.json()) as { result?: any; error?: { code: number; message: string } };
};

try {
  await ready();
  const get = http;

  // pages: a prerendered one (served from ASSETS) and a dynamic one (the pipeline)
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /June Basic/);
  assert.equal((await get("/users")).status, 200);

  // a static file straight from the ASSETS binding
  const logo = await get("/logo.svg");
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type") ?? "", /svg/);

  // markdown negotiation on a prerendered page (withAssets step 1)
  const md = await get("/", { headers: { accept: "text/markdown" } });
  assert.match(md.headers.get("content-type") ?? "", /text\/markdown/);

  for (const p of ["/llms.txt", "/sitemap.xml", "/.well-known/api-catalog"]) {
    assert.equal((await get(p)).status, 200, `${p} resolves on workerd`);
  }

  // POST with a body through withAssets → the pipeline: the #198 path
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(list.error, undefined, `tools/list → ${JSON.stringify(list.error)}`);
  assert.ok(list.result.tools.some((t: { name: string }) => t.name === "createUser"), "createUser is an MCP tool");

  const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "createUser", arguments: { name: "Grace" } } });
  assert.equal(call.error, undefined, `tools/call → ${JSON.stringify(call.error)}`);
  assert.match(call.result.content[0].text, /Grace/, "the action ran on the POSTed input");

  // The same endpoint in the 2026-07-28 era: the per-request `_meta` envelope and
  // the mirrored headers, no initialize.
  const modern = async (method: string, params: Record<string, unknown>, id: number) => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const res = await http("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }),
    });
    assert.equal(res.status, 200, `POST /mcp (2026-07-28 ${method}) → ${res.status}`);
    return (await res.json()) as { result?: any; error?: { code: number; message: string } };
  };
  const discover = await modern("server/discover", {}, 3);
  assert.deepEqual(discover.result?.supportedVersions, ["2026-07-28"], `server/discover → ${JSON.stringify(discover)}`);
  const modernCall = await modern("tools/call", { name: "createUser", arguments: { name: "Ada" } }, 4);
  assert.equal(modernCall.result?.resultType, "complete", `2026-07-28 tools/call → ${JSON.stringify(modernCall)}`);
  assert.match(modernCall.result.content[0].text, /Ada/, "the action ran on the 2026-07-28 request");

  console.log("workerd smoke: OK (build, assets, pages, markdown negotiation, discovery, POST /mcp in both MCP eras)");
} catch (e) {
  // name a mid-run crash plainly — otherwise it surfaces as a bare connection error
  const died = exited() ? ` (wrangler died mid-run: ${exitStatus()})` : "";
  console.error(`workerd smoke FAILED${died}\n--- wrangler log ---\n${log}`);
  throw e;
} finally {
  stop();
}
process.exit(0);
