// The deno() adapter (Deno Deploy): same portable bundle, an entry that wraps the
// pipeline in Deno.serve + withDenoAssets (in-process static serving). Units drive
// the pieces; one e2e runs a real juneBuild; withDenoAssets is exercised with a
// fake Deno global (no real Deno needed in `bun test`).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deno } from "../src/adapter";
import { juneBuild } from "../src/build";
import { withDenoAssets } from "../src/worker";

describe("deno() adapter — units", () => {
  test("declares edge capabilities + the deno/edge-light condition order", () => {
    const a = deno();
    expect(a.name).toBe("deno");
    expect(a.capabilities).toEqual({ runtime: "edge", persistentConnections: true, assets: "server" });
    expect(a.conditions[0]).toBe("deno"); // a deno-specific build wins if present
    expect(a.conditions).toContain("edge-light"); // else react-dom server.edge.js
    expect(a.conditions).not.toContain("worker"); // never the browser SSR build
  });

  test("validate: turso() allowed, sqlite()/d1() rejected (D1 is Cloudflare-only)", () => {
    const v = deno().validate!;
    const cfg = (kind?: string) => ({ plan: {}, config: kind ? { resources: { db: { kind } } } : {} }) as never;
    expect(() => v(cfg("turso"))).not.toThrow();
    expect(() => v(cfg("sqlite"))).toThrow(/isn't supported on Deno Deploy/);
    expect(() => v(cfg("d1"))).toThrow(/isn't supported on Deno Deploy/);
    expect(() => v(cfg())).not.toThrow();
  });

  test("entry: Deno.serve(withDenoAssets(pipeline)), helper imported from ./worker", () => {
    const e = deno().entry({ linkHeader: null });
    expect(e.imports).toContain(`import { withDenoAssets } from "@junejs/server/worker";`);
    expect(e.wrap("pipeline")).toBe("Deno.serve(withDenoAssets(pipeline));");
  });

  test("emit writes a deno.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-deno-"));
    try {
      await deno({ project: "my-deno-app" }).emit({
        appRoot: dir,
        outDir: dir,
        hasAssets: false,
        linkHeader: null,
        config: {},
        plan: {},
        defaultName: "d",
      });
      expect(JSON.parse(await readFile(join(dir, "deno.json"), "utf8"))).toEqual({ name: "my-deno-app" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withDenoAssets (fake Deno global)", () => {
  const realDeno = (globalThis as Record<string, unknown>).Deno;
  afterEach(() => {
    (globalThis as Record<string, unknown>).Deno = realDeno;
  });

  test("serves /_june/* from disk (immutable, typed); else falls through to the pipeline", async () => {
    const reads: string[] = [];
    (globalThis as Record<string, unknown>).Deno = {
      readFile: async (p: URL) => {
        reads.push(p.toString());
        if (p.toString().includes("global.abc123.css")) return new TextEncoder().encode(".a{color:red}");
        throw new Error("ENOENT"); // any other path "doesn't exist" → fall through
      },
      env: { toObject: () => ({ FOO: "bar" }) },
    };
    let pipelineEnv: unknown;
    const pipeline = {
      fetch: async (_req: Request, env?: unknown) => {
        pipelineEnv = env;
        return new Response("rendered", { status: 200 });
      },
    };
    const handler = withDenoAssets(pipeline);

    // a hashed asset → served from disk, immutable, css content-type
    const asset = await handler(new Request("http://x/_june/global.abc123.css"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/css");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe(".a{color:red}");

    // a missing asset → falls through to the pipeline
    const miss = await handler(new Request("http://x/_june/nope.css"));
    expect(await miss.text()).toBe("rendered"); // pipeline handled it

    // a page → straight to the pipeline, env from Deno.env
    const page = await handler(new Request("http://x/about"));
    expect(await page.text()).toBe("rendered");
    expect(pipelineEnv).toEqual({ FOO: "bar" });
  });
});

describe("deno() adapter — e2e (real juneBuild)", () => {
  const ROOT = dirname(fileURLToPath(new URL("./fixtures/deno-app/app", import.meta.url)));
  let outDir: string | undefined;
  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
    await rm(join(ROOT, ".june"), { recursive: true, force: true });
  });

  test("builds a Deno.serve bundle + deno.json + co-located /_june assets", async () => {
    outDir = await mkdtemp(join(tmpdir(), "june-deno-build-"));
    await juneBuild(ROOT, { outDir });

    const fn = await readFile(join(outDir, "worker.js"), "utf8");
    expect(fn).toContain("Deno.serve(withDenoAssets("); // the entry self-starts on Deno
    expect(fn).toContain("pipeline.fetch(request"); // the portable pipeline is wrapped
    expect(existsSync(join(outDir, "deno.json"))).toBe(true);
    // hashed framework assets sit beside the bundle for withDenoAssets to serve
    const assets = await readdir(join(outDir, "assets", "_june")).catch(() => []);
    expect(assets.some((f) => /\.[a-f0-9]{8}\.css$/.test(f))).toBe(true);
  });
});
