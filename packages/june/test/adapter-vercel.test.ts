// The Vercel adapter: edge-light conditions, a bare-pipeline edge entry (no
// withAssets), fail-fast on db, and a Build Output API v3 tree. Unit tests drive
// the pieces with fake artifacts; one e2e runs a real juneBuild through it.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { vercel } from "../src/adapter";
import { juneBuild } from "../src/build";

describe("vercel() adapter — units", () => {
  test("targets edge-light, not workerd", () => {
    const a = vercel();
    expect(a.name).toBe("vercel");
    expect(a.conditions[0]).toBe("edge-light");
    expect(a.conditions).not.toContain("workerd");
    expect(a.capabilities.runtime).toBe("edge");
  });

  test("validate fails fast when a db resource is declared", () => {
    expect(() => vercel().validate!({ plan: { db: { binding: "DB", databaseName: "x" } }, config: {} })).toThrow(
      /no db backend yet/,
    );
    expect(() => vercel().validate!({ plan: {}, config: {} })).not.toThrow(); // no db → ok
  });

  test("entry is the bare pipeline (no withAssets) and reads env from process", () => {
    const e = vercel().entry({ linkHeader: null });
    expect(e.imports).toEqual([]); // no withAssets import
    const wrapped = e.wrap("pipeline");
    expect(wrapped).toContain("export default (request) => pipeline.fetch(request,");
    expect(wrapped).toContain("process"); // env via process.env
    expect(wrapped).not.toContain("withAssets");
  });

  test("emit writes a valid Build Output API v3 tree", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "june-vc-"));
    try {
      // fake the build artifacts emit() consumes
      const outDir = join(appRoot, "dist");
      await mkdir(join(outDir, "assets", "_june"), { recursive: true });
      await writeFile(join(outDir, "worker.js"), "export default () => new Response('ok');");
      await writeFile(join(outDir, "assets", "_june", "client.abcd1234.js"), "console.log(1)");

      await vercel().emit({
        appRoot,
        outDir,
        hasAssets: true,
        linkHeader: null,
        config: {},
        plan: {},
        defaultName: "demo",
      });

      const out = join(appRoot, ".vercel", "output");
      // function: edge runtime, entrypoint = the verbatim worker bundle
      const vc = JSON.parse(await readFile(join(out, "functions", "__june.func", ".vc-config.json"), "utf8"));
      expect(vc).toMatchObject({ runtime: "edge", entrypoint: "index.js" });
      const fn = await readFile(join(out, "functions", "__june.func", "index.js"), "utf8");
      expect(fn).toContain("new Response('ok')"); // copied from worker.js

      // static: only the hashed framework assets
      expect(existsSync(join(out, "static", "_june", "client.abcd1234.js"))).toBe(true);

      // config.json: immutable /_june/, then filesystem, then catch-all → /__june
      const cfg = JSON.parse(await readFile(join(out, "config.json"), "utf8"));
      expect(cfg.version).toBe(3);
      expect(cfg.routes[0]).toMatchObject({ src: "^/_june/(.*)$", continue: true });
      expect(cfg.routes[0].headers["cache-control"]).toContain("immutable");
      expect(cfg.routes).toContainEqual({ handle: "filesystem" });
      expect(cfg.routes[cfg.routes.length - 1]).toEqual({ src: "^/.*$", dest: "/__june" });
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  test("emit skips static when there are no assets", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "june-vc-"));
    try {
      const outDir = join(appRoot, "dist");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "worker.js"), "export default () => {}");
      await vercel().emit({ appRoot, outDir, hasAssets: false, linkHeader: null, config: {}, plan: {}, defaultName: "d" });
      expect(existsSync(join(appRoot, ".vercel", "output", "static"))).toBe(false);
      expect(existsSync(join(appRoot, ".vercel", "output", "functions", "__june.func", "index.js"))).toBe(true);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
});

describe("vercel() adapter — e2e (real juneBuild)", () => {
  const ROOT = dirname(fileURLToPath(new URL("./fixtures/vercel-app/app", import.meta.url)));
  let outDir: string | undefined;
  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
    await rm(join(ROOT, ".vercel"), { recursive: true, force: true }); // emit() writes here
  });

  test("builds the Vercel output: edge function from the real bundle, no withAssets", async () => {
    outDir = await mkdtemp(join(tmpdir(), "june-vc-build-"));
    await juneBuild(ROOT, { outDir });

    const out = join(ROOT, ".vercel", "output");
    expect(existsSync(join(out, "config.json"))).toBe(true);

    const vc = JSON.parse(await readFile(join(out, "functions", "__june.func", ".vc-config.json"), "utf8"));
    expect(vc.runtime).toBe("edge");

    // the bundled edge function is the REAL worker, wrapped as the bare fetch
    // shim — env from process.env, NO withAssets (workers-only)
    const fn = await readFile(join(out, "functions", "__june.func", "index.js"), "utf8");
    expect(fn).toContain("pipeline.fetch(request, __env)"); // the vercel entry shim
    expect(fn).toContain("typeof process"); // env via process.env, not a binding
    expect(fn).not.toContain("withAssets"); // workers-only
    expect(fn.length).toBeGreaterThan(1000); // a real bundle, not a stub
  });
});
