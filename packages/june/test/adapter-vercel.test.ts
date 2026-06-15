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
  test("defaults to the node runtime; the bundle still targets edge-light", () => {
    const a = vercel();
    expect(a.name).toBe("vercel");
    // The bundle conditions are unchanged regardless of runtime. NOT
    // "worker"/"browser": react-dom maps "worker" → its browser SSR build, which
    // crashes — must reach "edge-light" → server.edge.js, which runs on Node too.
    expect(a.conditions[0]).toBe("edge-light");
    expect(a.conditions).not.toContain("workerd");
    expect(a.conditions).not.toContain("worker");
    expect(a.conditions).not.toContain("browser");
    // Node (Fluid compute) is the default; edge is opt-in.
    expect(a.capabilities.runtime).toBe("node");
    expect(a.capabilities.persistentConnections).toBe(true);
    expect(vercel({ runtime: "edge" }).capabilities.runtime).toBe("edge");
  });

  test("validate fails fast when a db resource is declared", () => {
    expect(() => vercel().validate!({ plan: { db: { binding: "DB", databaseName: "x" } }, config: {} })).toThrow(
      /no db backend yet/,
    );
    expect(() => vercel().validate!({ plan: {}, config: {} })).not.toThrow(); // no db → ok
  });

  test("node entry is the fetch Web Standard export; edge entry is the bare function", () => {
    const node = vercel().entry({ linkHeader: null });
    expect(node.imports).toEqual([]); // no withAssets import
    const nodeWrap = node.wrap("pipeline");
    // Node runtime captures `export default { fetch }`
    expect(nodeWrap).toContain("export default { fetch: (request) => pipeline.fetch(request,");
    expect(nodeWrap).toContain("process"); // env via process.env
    expect(nodeWrap).not.toContain("withAssets");

    // Edge runtime takes a bare default function
    const edgeWrap = vercel({ runtime: "edge" }).entry({ linkHeader: null }).wrap("pipeline");
    expect(edgeWrap).toContain("export default (request) => pipeline.fetch(request,");
    expect(edgeWrap).not.toContain("{ fetch:");
  });

  test("emit writes a valid Build Output API v3 tree", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "june-vc-"));
    try {
      // fake the build artifacts emit() consumes: worker.js + a code-split chunk
      // (top-level), plus a hashed asset (under assets/)
      const outDir = join(appRoot, "dist");
      await mkdir(join(outDir, "assets", "_june"), { recursive: true });
      await writeFile(join(outDir, "worker.js"), "import './cache-abc123.js';\nexport default () => new Response('ok');");
      await writeFile(join(outDir, "cache-abc123.js"), "export const c = 1;");
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
      const fnDir = join(out, "functions", "__june.func");
      // function: node runtime (default), the worker bundle as the ESM handler
      const vc = JSON.parse(await readFile(join(fnDir, ".vc-config.json"), "utf8"));
      expect(vc).toMatchObject({
        runtime: "nodejs22.x",
        handler: "worker.js",
        launcherType: "Nodejs",
        supportsResponseStreaming: true, // else a streamed Response is buffered
      });
      // the ESM bundle needs the function dir marked as a module or Node loads CJS
      expect(JSON.parse(await readFile(join(fnDir, "package.json"), "utf8"))).toEqual({ type: "module" });
      expect(await readFile(join(fnDir, "worker.js"), "utf8")).toContain("new Response('ok')");
      // the code-split chunk is copied beside the entry (else Vercel rejects it)
      expect(existsSync(join(fnDir, "cache-abc123.js"))).toBe(true);

      // static: only the hashed framework assets (the chunk is NOT a static asset)
      expect(existsSync(join(out, "static", "_june", "client.abcd1234.js"))).toBe(true);
      expect(existsSync(join(out, "static", "_june", "cache-abc123.js"))).toBe(false);

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

  test("runtime: 'edge' emits an Edge Function (entrypoint, no launcher / package.json)", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "june-vc-"));
    try {
      const outDir = join(appRoot, "dist");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "worker.js"), "export default () => new Response('ok')");
      await vercel({ runtime: "edge" }).emit({
        appRoot,
        outDir,
        hasAssets: false,
        linkHeader: null,
        config: {},
        plan: {},
        defaultName: "d",
      });
      const fnDir = join(appRoot, ".vercel", "output", "functions", "__june.func");
      const vc = JSON.parse(await readFile(join(fnDir, ".vc-config.json"), "utf8"));
      expect(vc).toEqual({ runtime: "edge", entrypoint: "worker.js" });
      expect(existsSync(join(fnDir, "package.json"))).toBe(false); // edge sources are ESM already
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
      expect(existsSync(join(appRoot, ".vercel", "output", "functions", "__june.func", "worker.js"))).toBe(true);
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

  test("builds the Vercel output: node function from the real bundle, no withAssets", async () => {
    outDir = await mkdtemp(join(tmpdir(), "june-vc-build-"));
    await juneBuild(ROOT, { outDir });

    const out = join(ROOT, ".vercel", "output");
    expect(existsSync(join(out, "config.json"))).toBe(true);

    const fnDir = join(out, "functions", "__june.func");
    const vc = JSON.parse(await readFile(join(fnDir, ".vc-config.json"), "utf8"));
    expect(vc.runtime).toBe("nodejs22.x");
    expect(vc.supportsResponseStreaming).toBe(true); // SSE / streamed SSR
    expect(JSON.parse(await readFile(join(fnDir, "package.json"), "utf8"))).toEqual({ type: "module" });

    // the bundled function is the REAL worker, wrapped as the fetch Web Standard
    // export — env from process.env, NO withAssets (workers-only)
    const fn = await readFile(join(fnDir, "worker.js"), "utf8");
    expect(fn).toContain("pipeline.fetch(request, __env)"); // the vercel entry shim
    expect(fn).toContain("fetch:"); // the { fetch } node export shape
    expect(fn).toContain("typeof process"); // env via process.env, not a binding
    expect(fn).not.toContain("withAssets"); // workers-only
    expect(fn.length).toBeGreaterThan(1000); // a real bundle, not a stub
  });
});
