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

import { staticSite } from "../src/adapter";
import { juneBuild, normalizeBase } from "../src/build";

describe("staticSite() adapter — units", () => {
  test("declares static capabilities + a portable edge-light condition (no server)", () => {
    const a = staticSite();
    expect(a.name).toBe("static");
    expect(a.capabilities).toEqual({ runtime: "static", persistentConnections: false, assets: "none" });
    expect(a.conditions[0]).toBe("edge-light"); // react-dom server.edge.js, runs in the build host
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
