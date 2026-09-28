// The staticSite() target (GitHub Pages / any dumb file host): no server runs, so
// `june build` prerenders EVERY route + projection to disk. Units drive the adapter
// pieces + normalizeBase; one e2e runs a real juneBuild over fixtures/static-app
// (i18n + a dynamic catch-all with staticPaths) and asserts the published tree.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PRERENDER_ORIGIN } from "@junejs/core/document";

import { staticSite } from "../src/adapter";
import { juneBuild, normalizeBase } from "../src/build";

describe("staticSite() adapter — units", () => {
  test("declares static capabilities + a portable edge-light condition (no server)", () => {
    const a = staticSite();
    expect(a.name).toBe("static");
    expect(a.capabilities).toEqual({ runtime: "static", persistentConnections: false, assets: "none" });
    expect(a.conditions[0]).toBe("source"); // June's own src/*.ts wins when bundling the app
    expect(a.conditions[1]).toBe("edge-light"); // react-dom server.edge.js, runs in the build host
    expect(a.conditions).not.toContain("workerd");
    expect(a.buildExternal).toContain("workers-og"); // defensive: never breaks the bundle
  });

  test("validate: a db resource is rejected (a static site has no server)", () => {
    const v = staticSite().validate!;
    const cfg = (kind?: string) => ({ plan: {}, config: kind ? { resources: { db: { kind } } } : {} }) as never;
    expect(() => v(cfg("sqlite"))).toThrow(/static.*has no runtime/s);
    expect(() => v(cfg("turso"))).toThrow(/static.*has no runtime/s);
    expect(() => v(cfg())).not.toThrow(); // no db → fine
  });

  test("entry: a valid no-op module wrapper (worker.js is never deployed on static)", () => {
    const e = staticSite().entry({ linkHeader: null });
    expect(e.imports).toEqual([]);
    expect(e.wrap("pipeline")).toContain("pipeline.fetch(request)");
  });

  test("emit copies outDir/assets → outDir/static and writes .nojekyll", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-static-emit-"));
    try {
      await mkdir(join(dir, "assets", "_june"), { recursive: true });
      await writeFile(join(dir, "assets", "index.html"), "<h1>hi</h1>");
      await writeFile(join(dir, "assets", "_june", "app.css"), ".a{}");
      const ctx = { appRoot: dir, outDir: dir, hasAssets: true, linkHeader: null, config: {}, plan: {}, defaultName: "s" };
      await staticSite().emit(ctx as never);
      expect(await readFile(join(dir, "static", "index.html"), "utf8")).toBe("<h1>hi</h1>");
      expect(existsSync(join(dir, "static", "_june", "app.css"))).toBe(true);
      // .nojekyll disables Jekyll so GitHub Pages doesn't strip the _june/ dir
      expect(existsSync(join(dir, "static", ".nojekyll"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeBase", () => {
  test("leading slash added, trailing slash dropped, empty stays empty", () => {
    expect(normalizeBase(undefined)).toBe("");
    expect(normalizeBase("")).toBe("");
    expect(normalizeBase("/openab/docs")).toBe("/openab/docs");
    expect(normalizeBase("/openab/docs/")).toBe("/openab/docs");
    expect(normalizeBase("openab")).toBe("/openab");
  });
});

describe("staticSite() target — e2e (real juneBuild over an i18n app)", () => {
  const ROOT = dirname(fileURLToPath(new URL("./fixtures/static-app/app", import.meta.url)));
  let outDir: string | undefined;
  const read = (rel: string) => readFile(join(outDir!, "static", rel), "utf8");
  const has = (rel: string) => existsSync(join(outDir!, "static", rel));

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
    await rm(join(ROOT, ".june"), { recursive: true, force: true });
  });

  test("prerenders every route + locale variant + dynamic staticPaths to dist/static/", async () => {
    outDir = await mkdtemp(join(tmpdir(), "june-static-build-"));
    const r = await juneBuild(ROOT, { outDir });

    // dynamic catch-all is reported dynamic, yet its staticPaths pages are prerendered
    expect(r.dynamicRoutes).toContain("/[[...slug]]");
    expect(r.prerendered).toEqual(
      expect.arrayContaining(["/", "/de", "/about", "/de/about", "/guide/getting-started", "/de/guide/getting-started"]),
    );

    // clean directory-style URLs: <stem>/index.html for pages (home is index.html)
    expect(has("index.html")).toBe(true);
    expect(has("about/index.html")).toBe(true);
    expect(has("guide/getting-started/index.html")).toBe(true);
    // locale expansion of static routes (defaultLocale bare, others prefixed)
    expect(has("de/index.html")).toBe(true);
    expect(has("de/about/index.html")).toBe(true);
    // dynamic route pages the catch-all enumerated (incl. a locale-prefixed one)
    expect(has("guide/advanced/index.html")).toBe(true);
    expect(has("de/guide/getting-started/index.html")).toBe(true);

    // projections stay FLAT (exact-path negotiation, no rewrite server)
    expect(has("about.md")).toBe(true);
    // the LOCALE home's projections live under the prefix dir ("/de.md" has no "/" boundary for
    // the locale matcher, so it used to fall into the catch-all as a phantom "de.md" slug)
    expect(has("de/index.md")).toBe(true);
    expect(has("de.md")).toBe(false);
    expect(has("guide/getting-started.md")).toBe(true);
    expect(has("guide/getting-started.json")).toBe(true); // json is a function → emitted

    // static-host essentials
    expect(has(".nojekyll")).toBe(true);
    expect(has("404.html")).toBe(true);
    expect(has("favicon.svg")).toBe(true);
  });

  test("asset URLs in the HTML are prefixed with the deploy basePath (/base)", async () => {
    const html = await read("index.html");
    // the hashed global stylesheet + favicon resolve under the subpath
    expect(html).toMatch(/href="\/base\/_june\/global\.[a-f0-9]+\.css"/);
    expect(html).toContain('href="/base/favicon.svg"');
    // charset stays in the document (asset-served pages may lack the header param)
    expect(html).toContain('<meta charSet="utf-8"/>');
  });

  test("the German home renders in German (locale prefix stripped at prerender)", async () => {
    expect(await read("de/index.html")).toContain('<html lang="de">');
    expect(await read("index.html")).toContain('<html lang="en">');
  });

  test("a dynamic page renders its slug + resolved locale", async () => {
    // (React inserts a `<!-- -->` marker between adjacent text nodes, so assert the
    // slug + locale substrings rather than the joined "Guide: <slug>" string.)
    const en = await read("guide/getting-started/index.html");
    expect(en).toContain("guide/getting-started");
    expect(en).toContain('data-locale="en"');
    expect(await read("de/guide/getting-started/index.html")).toContain('data-locale="de"');
  });
});

describe("staticSite() — staticPaths feed prerender AND the sitemap (no i18n)", () => {
  const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
  let root: string | undefined;
  let outDir: string | undefined;
  afterAll(async () => {
    for (const d of [root, outDir]) if (d) await rm(d, { recursive: true, force: true });
  });

  test("a producer runs exactly once; the sitemap lists exactly the prerendered set", async () => {
    // under the package so the fixture's JSX resolves June's jsx runtime
    root = await mkdtemp(join(PKG_DIR, ".tmp-static-sp-"));
    const files: Record<string, string> = {
      "june.config.ts": `export default { site: { name: "SP" }, deploy: { target: "static" } };\n`,
      "app/page.tsx": "export default function Home(){return <main>home</main>;}\n",
      "app/guide/[slug]/page.tsx":
        "export const staticPaths = () => {\n" +
        "  (globalThis as any).__juneSpCalls = ((globalThis as any).__juneSpCalls ?? 0) + 1;\n" +
        "  return ['/guide/a', '/guide/b'];\n" +
        "};\n" +
        "export default function G(){return <main>guide</main>;}\n",
    };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), body);
    }
    (globalThis as any).__juneSpCalls = 0;
    outDir = await mkdtemp(join(tmpdir(), "june-static-sp-"));
    const r = await juneBuild(root, { outDir });

    expect((globalThis as any).__juneSpCalls).toBe(1);
    const xml = await readFile(join(outDir, "static", "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
    expect(locs.sort()).toEqual([...r.prerendered].sort());
    expect(locs).toContain("/guide/a");
  });
});

describe("staticSite() target — agent catalogs", () => {
  const ROOT = dirname(fileURLToPath(new URL("./fixtures/static-root-app/app", import.meta.url)));
  const BASE_ROOT = dirname(fileURLToPath(new URL("./fixtures/static-app/app", import.meta.url)));
  const OFF_ROOT = dirname(fileURLToPath(new URL("./fixtures/static-nodiscovery-app/app", import.meta.url)));
  const dirs: string[] = [];

  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    for (const r of [ROOT, BASE_ROOT, OFF_ROOT]) await rm(join(r, ".june"), { recursive: true, force: true });
  });

  test("agent.discovery off publishes no catalog file, even with a catch-all route that answers any path", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "june-static-catalogs-off-"));
    dirs.push(outDir);
    await juneBuild(OFF_ROOT, { outDir });
    expect(existsSync(join(outDir, "static", ".well-known"))).toBe(false);
    expect(await readFile(join(outDir, "static", "index.html"), "utf8")).not.toContain('rel="ai-catalog"');
  });

  test("a root deploy prerenders the ARD catalog + skills naming the public origin, never the prerender host", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "june-static-catalogs-"));
    dirs.push(outDir);
    await juneBuild(ROOT, { outDir });
    const read = (rel: string) => readFile(join(outDir, "static", rel), "utf8");

    const catalog = await read(".well-known/ai-catalog.json");
    expect(await read(".well-known/ard.json")).toBe(catalog);
    expect(JSON.parse(catalog).host.identifier).toBe("did:web:static.example");

    const index = JSON.parse(await read(".well-known/agent-skills/index.json"));
    const entry = index.skills[0];
    expect(entry.url).toBe("https://static.example/.well-known/agent-skills/static-example/SKILL.md");
    const md = await readFile(join(outDir, "static", ".well-known/agent-skills/static-example/SKILL.md"));
    expect(entry.digest).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(md).digest("hex")}`);

    for (const f of [catalog, JSON.stringify(index), md.toString("utf8")]) expect(f).not.toContain(PRERENDER_ORIGIN);

    // A static host runs no /mcp: the app's tool is projected out of everything
    // published — the catalog, the skill, llms.txt, and the pages' WebMCP script.
    expect(JSON.parse(catalog).entries.map((e: { type: string }) => e.type)).toEqual(["application/agent-skills+md"]);
    const llms = await read("llms.txt");
    const html = await read("index.html");
    for (const f of [md.toString("utf8"), llms]) expect(f).not.toContain("/mcp");
    for (const f of [md.toString("utf8"), llms, html]) expect(f).not.toContain("lookup");
    // (the HTML still names /mcp in its speculation-rules EXCLUSIONS — not an advertisement)
    expect(html).not.toContain("modelContext");
    // the page links the catalog it ships with
    expect(html).toContain('<link rel="ai-catalog" href="/.well-known/ai-catalog.json"');
  });

  test("a basePath deploy publishes no /.well-known catalogs (it doesn't own the domain root)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "june-static-catalogs-base-"));
    dirs.push(outDir);
    await juneBuild(BASE_ROOT, { outDir });
    expect(existsSync(join(outDir, "static", ".well-known", "ai-catalog.json"))).toBe(false);
    expect(existsSync(join(outDir, "static", ".well-known", "agent-skills"))).toBe(false);
    // …and no page advertises the catalog it doesn't ship
    const html = await readFile(join(outDir, "static", "index.html"), "utf8");
    expect(html).not.toContain('rel="ai-catalog"');
  });
});
