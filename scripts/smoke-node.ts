// Proves the Node host end-to-end: the SAME startDevServer the Bun host runs,
// served by node:http (host detection: no global Bun), exercised over real
// HTTP. CI runs this under Node so "Bun-first, Node-supported" stays a tested
// claim, not a code comment. Run: node --import tsx scripts/smoke-node.ts
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

assert.equal(typeof Bun, "undefined", "this smoke must run under Node, not Bun");

const appDir = fileURLToPath(new URL("../examples/basic/app", import.meta.url));
// Relative import: the repo root is not a workspace consumer of @junejs/server,
// so the package specifier only resolves inside apps/examples.
const { startDevServer } = await import("../packages/june/src/index.ts");

const server = await startDevServer({ appDir, port: 4399 });
try {
  const get = (p: string, init?: RequestInit) => fetch(`${server.url}${p}`, init);

  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /June Basic/);

  const users = await get("/users");
  assert.equal(users.status, 200);

  for (const p of ["/llms.txt", "/sitemap.xml", "/.well-known/api-catalog"]) {
    assert.equal((await get(p)).status, 200, `${p} resolves on the Node host`);
  }

  const mcp = (await (
    await get("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
  ).json()) as { result: { tools: Array<{ name: string }> } };
  assert.ok(
    mcp.result.tools.some((t) => t.name === "createUser"),
    "warmup-registered action is an MCP tool on the Node host",
  );

  console.log("node-host smoke: OK (serve, routes, discovery, mcp)");
} finally {
  server.stop(true);
}
process.exit(0);
