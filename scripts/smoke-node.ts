// Proves the Node host end-to-end: the SAME startDevServer the Bun host runs,
// served by node:http (host detection: no global Bun), exercised over real
// HTTP. CI runs this under Node so "Bun-first, Node-supported" stays a tested
// claim, not a code comment.
// Run: node --conditions=source --import tsx scripts/smoke-node.ts
// (--conditions=source resolves @junejs/* to src/*.ts — tsx compiles it — not the
// dual-export `default` → dist/*.js, which is unbuilt in this from-source run.)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(typeof Bun, "undefined", "this smoke must run under Node, not Bun");

// node:sqlite is only reached here: `bun test` always takes the bun:sqlite branch.
// A file database must open durable (WAL, synchronous=FULL) on this driver too.
{
  const { openLocalSqliteSync } = await import("../packages/june/src/sqlite-driver.ts");
  const dir = mkdtempSync(join(tmpdir(), "june-node-sqlite-"));
  try {
    const db = await openLocalSqliteSync(join(dir, "app.sqlite"));
    // node:sqlite rows are null-prototype objects: compare the field, not the object.
    const journal = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const sync = (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    assert.equal(journal, "wal", "node:sqlite file db is WAL");
    assert.equal(sync, 2, "node:sqlite file db is synchronous=FULL");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  console.log("node-host smoke: OK (sqlite durability, serve, routes, discovery, mcp)");
} finally {
  server.stop(true);
}
process.exit(0);
