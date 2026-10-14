// The built-in workers() adapter — the deploy seam. Its entry wraps the
// portable pipeline (withAssets) and emit writes the wrangler config, so
// build.ts stays target-agnostic.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasDurableBinding, hasLoaderRule, workers, vercel, deno } from "../src/adapter";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("workers() adapter", () => {
  test("declares edge capabilities", () => {
    const a = workers();
    expect(a.name).toBe("workers");
    expect(a.capabilities).toEqual({ runtime: "edge", persistentConnections: true, assets: "platform", durableObjects: true });
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

  test("declares workers-og as a required buildExternal (WASM needs wrangler bundling, not rolldown)", () => {
    const a = workers();
    expect(a.buildExternal).toContain("workers-og");
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

// ── binary imports (#379): wrangler loads .wasm by default and nothing else build.ts leaves
// external, so workers() gives each imported extension a Data rule, or warns about an
// app-owned config that lacks one.
describe("workers() — loaders for binary imports", () => {
  const ctx = (d: string, binaryImports?: string[]) => ({ appRoot: d, outDir: d, hasAssets: false, linkHeader: null, defaultName: "app", plan: {}, config: {}, binaryImports });

  test("emits one Data rule (with fallthrough) for the non-wasm extensions imported", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-adapter-"));
    await workers().emit(ctx(dir, ["otf", "png", "wasm"]));
    const w = JSON.parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    expect(w.rules).toEqual([{ type: "Data", globs: ["**/*.otf", "**/*.png"], fallthrough: true }]);
  });

  test("no rules when the bundle imports no binaries, or only .wasm", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-adapter-"));
    for (const imports of [undefined, [], ["wasm"]]) {
      await workers().emit(ctx(dir, imports));
      expect(JSON.parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")).rules).toBeUndefined();
    }
  });

  test("an app-owned config is left alone, with a warning naming the rule it lacks", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-adapter-"));
    const own = join(dir, "wrangler.jsonc");
    await writeFile(own, `{ "name": "mine", "main": "./worker.js" }`);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await workers().emit(ctx(dir, ["otf", "wasm"]));
      expect(await readFile(own, "utf8")).toBe(`{ "name": "mine", "main": "./worker.js" }`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(`"rules": [{ "type": "Data", "globs": ["**/*.otf"], "fallthrough": true }]`);
      warn.mockClear();
      await writeFile(own, `{ "name": "mine", "rules": [{ "type": "Data", "globs": ["**/*.otf"] }] }`);
      await workers().emit(ctx(dir, ["otf"]));
      expect(warn).not.toHaveBeenCalled();
      // Unparsable: it can't tell, so it says so rather than claiming the rule is missing.
      await writeFile(own, `{ "note": "see a // b", "rules": [{ "type": "Data", "globs": ["**/*.otf"] }] }`);
      await workers().emit(ctx(dir, ["otf"]));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("couldn't be parsed to check");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("hasLoaderRule", () => {
  test("jsonc: a glob ending in the extension counts, brace sets too; comments are stripped", () => {
    expect(hasLoaderRule(`{ "rules": [{ "type": "Data", "globs": ["**/*.otf"] }] }`, "wrangler.jsonc", "otf")).toBe(true);
    expect(hasLoaderRule(`{ "rules": [{ "type": "Data", "globs": ["fonts/*.{ttf,otf}"] }] }`, "wrangler.jsonc", "otf")).toBe(true);
    expect(hasLoaderRule(`{\n  // "rules": [{ "type": "Data", "globs": ["**/*.otf"] }]\n}`, "wrangler.jsonc", "otf")).toBe(false);
    expect(hasLoaderRule(`{ "rules": [{ "type": "Data", "globs": ["**/*.otfx"] }] }`, "wrangler.jsonc", "otf")).toBe(false);
  });

  test("jsonc it can't parse is unknown, not found: the extension appearing elsewhere is not a rule", () => {
    // stripJsonc takes the // inside this string for a comment, so the parse fails.
    expect(hasLoaderRule(`{ "name": "app", "note": "uses .otf // data" }`, "wrangler.jsonc", "otf")).toBeUndefined();
  });

  test("toml: a [[rules]] table's globs count; a commented one or another table's does not", () => {
    expect(hasLoaderRule(`[[rules]]\ntype = "Data"\nglobs = ["**/*.ttf", "**/*.otf"]\n`, "wrangler.toml", "otf")).toBe(true);
    expect(hasLoaderRule(`# [[rules]]\n# type = "Data"\n# globs = ["**/*.otf"]\n`, "wrangler.toml", "otf")).toBe(false);
    expect(hasLoaderRule(`[vars]\nglobs = ["**/*.otf"]\n`, "wrangler.toml", "otf")).toBe(false);
  });
});

// ── hasDurableBinding: does an app-owned wrangler config really bind the DO? ──
// The warning this feeds must fire unless the class is bound UNDER THE NAME
// createWorker reads (env.AGENT) — a migrations-only mention, a binding under
// another name, or a commented-out table are all "not bound".
describe("hasDurableBinding", () => {
  const B = "AGENT";
  const C = "JuneAgentDO";

  test("jsonc: a real AGENT binding counts; comments are stripped first", () => {
    const cfg = `{
  // the durable agent
  "durable_objects": { "bindings": [{ "name": "AGENT", "class_name": "JuneAgentDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["JuneAgentDO"] }],
}`;
    expect(hasDurableBinding(cfg, "wrangler.jsonc", B, C)).toBe(true);
  });

  test("jsonc: migrations-only mention of the class is NOT bound", () => {
    const cfg = `{ "migrations": [{ "tag": "v1", "new_sqlite_classes": ["JuneAgentDO"] }] }`;
    expect(hasDurableBinding(cfg, "wrangler.jsonc", B, C)).toBe(false);
  });

  test("jsonc: the class bound under another name is NOT the binding createWorker reads", () => {
    const cfg = `{ "durable_objects": { "bindings": [{ "name": "OTHER", "class_name": "JuneAgentDO" }] } }`;
    expect(hasDurableBinding(cfg, "wrangler.jsonc", B, C)).toBe(false);
  });

  test("toml: a [[durable_objects.bindings]] table with matching name + class counts", () => {
    const cfg = `name = "app"\n\n[[durable_objects.bindings]]\nname = "AGENT"\nclass_name = "JuneAgentDO"\n\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["JuneAgentDO"]\n`;
    expect(hasDurableBinding(cfg, "wrangler.toml", B, C)).toBe(true);
  });

  test("toml: a commented-out binding does not count", () => {
    const cfg = `name = "app"\n# [[durable_objects.bindings]]\n# name = "AGENT"\n# class_name = "JuneAgentDO"\n`;
    expect(hasDurableBinding(cfg, "wrangler.toml", B, C)).toBe(false);
  });

  test("toml: a binding under another name, or another class under AGENT, is NOT bound", () => {
    const other = `[[durable_objects.bindings]]\nname = "OTHER"\nclass_name = "JuneAgentDO"\n`;
    const wrongClass = `[[durable_objects.bindings]]\nname = "AGENT"\nclass_name = "SomethingElse"\n`;
    expect(hasDurableBinding(other, "wrangler.toml", B, C)).toBe(false);
    expect(hasDurableBinding(wrongClass, "wrangler.toml", B, C)).toBe(false);
  });

  test("toml: the matching table is found even when another bindings table precedes it", () => {
    const cfg = `[[durable_objects.bindings]]\nname = "OTHER"\nclass_name = "X"\n\n[[durable_objects.bindings]]\nname = "AGENT"\nclass_name = "JuneAgentDO"\n\n[vars]\nFOO = "bar"\n`;
    expect(hasDurableBinding(cfg, "wrangler.toml", B, C)).toBe(true);
  });

  test("a '#' inside a TOML string is not a comment", () => {
    const cfg = `[[durable_objects.bindings]]\nname = "AGENT"\nclass_name = "JuneAgentDO" # bound\ndescription = "uses # in a string"\n`;
    expect(hasDurableBinding(cfg, "wrangler.toml", B, C)).toBe(true);
  });
});
