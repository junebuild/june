// The built-in workers() adapter — the deploy seam. Its entry wraps the
// portable pipeline (withAssets) and emit writes the wrangler config, so
// build.ts stays target-agnostic.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workers } from "../src/adapter";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("workers() adapter", () => {
  test("declares edge capabilities", () => {
    const a = workers();
    expect(a.name).toBe("workers");
    expect(a.capabilities).toEqual({ runtime: "edge", persistentConnections: true, assets: "platform" });
  });

  test("entry wraps the pipeline in withAssets with the frozen Link header", () => {
    const e = workers().entry({ linkHeader: '</llms.txt>; rel="llms-txt"' });
    expect(e.imports).toContain(`import { withAssets } from "@junejs/server/worker";`);
    const wrap = e.wrap("pipeline");
    expect(wrap).toContain("withAssets(pipeline,");
    expect(wrap).toContain("link:");
    expect(wrap).toContain("llms-txt"); // JSON-encoded into the generated source
    expect(wrap).toContain("export default");
  });

  test("emit writes wrangler.jsonc: assets binding + run_worker_first, name from config, domain route", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-adapter-"));
    await workers().emit({
      appRoot: dir,
      outDir: dir,
      hasAssets: true,
      linkHeader: null,
      defaultName: "fallback",
      plan: {},
      config: { deploy: { name: "my-app", domain: "example.com" } },
    });
    const w = JSON.parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    expect(w.name).toBe("my-app");
    expect(w.main).toBe("./worker.js");
    expect(w.compatibility_flags).toContain("nodejs_compat");
    expect(w.assets).toEqual({ directory: "./assets", binding: "ASSETS", run_worker_first: true });
    expect(w.routes).toEqual([{ pattern: "example.com", custom_domain: true }]);
    expect(w.d1_databases).toBeUndefined(); // no db in the plan
  });

  test("emit falls back to defaultName and omits assets when none, domain when none", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-adapter-"));
    await workers().emit({ appRoot: dir, outDir: dir, hasAssets: false, linkHeader: null, defaultName: "fallback", plan: {}, config: {} });
    const w = JSON.parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    expect(w.name).toBe("fallback");
    expect(w.assets).toBeUndefined();
    expect(w.routes).toBeUndefined();
  });

  test("emit writes a d1_databases binding when the plan declares a db", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-adapter-"));
    await workers().emit({
      appRoot: dir,
      outDir: dir,
      hasAssets: false,
      linkHeader: null,
      defaultName: "myapp",
      plan: { db: { binding: "DB", databaseName: "myapp-db" } },
      config: {},
    });
    const w = JSON.parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    // The binding is fully wired; only the per-account database_id is left blank
    // (filled by `wrangler d1 create`). bindWorkerResources reads env.DB at runtime.
    expect(w.d1_databases).toEqual([{ binding: "DB", database_name: "myapp-db", database_id: "" }]);
  });
});
