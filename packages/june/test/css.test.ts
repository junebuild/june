// CSS: the auto-link convention (app/global.css → /_june/global.css, document
// <link>s it), the build's content-hashed asset under /_june/, and the immutable
// cache header hashed assets get from withAssets.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { juneBuild } from "../src/build";
import { withAssets } from "../src/worker";
import { processCss, findGlobalCss, STYLES_URL, minifyCss, cssTargets } from "../src/css";

const CSS_APP = fileURLToPath(new URL("./fixtures/css/app", import.meta.url));
const CSS_ROOT = dirname(CSS_APP); // the app ROOT (juneBuild takes the root, not app/)
const NOCSS_APP = fileURLToPath(new URL("./fixtures/db/app", import.meta.url)); // has no global.css

describe("global.css auto-link", () => {
  test("app/global.css → /_june/global.css is served as text/css", async () => {
    const app = createApp({ appDir: CSS_APP, config: {} });
    const res = await app.fetch(new Request("http://june.test/_june/global.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain("rebeccapurple");
  });

  test("the document links it after the inline base styles", async () => {
    const app = createApp({ appDir: CSS_APP, config: {} });
    const html = await (await app.fetch(new Request("http://june.test/"))).text();
    expect(html).toContain(`<link rel="stylesheet" href="${STYLES_URL}"`);
    // it comes AFTER the inline <style> so it (and a Tailwind reset) wins
    expect(html.indexOf("</style>")).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  test("no app/global.css → no stylesheet link (zero-config, parity-safe)", async () => {
    expect(findGlobalCss(NOCSS_APP)).toBeNull();
    const app = createApp({ appDir: NOCSS_APP, config: {} });
    const html = await (await app.fetch(new Request("http://june.test/"))).text();
    expect(html).not.toContain('rel="stylesheet"');
  });

  test("processCss passes plain CSS through unchanged", async () => {
    expect(await processCss(CSS_APP)).toContain("rebeccapurple");
    expect(await processCss(NOCSS_APP)).toBeNull();
  });

  test("framework assets live under the reserved /_june/ prefix", () => {
    expect(STYLES_URL.startsWith("/_june/")).toBe(true);
  });
});

describe("minifyCss (Lightning CSS)", () => {
  test("collapses whitespace + comments but keeps scoped identifiers", async () => {
    const out = await minifyCss(
      ".hero_ab12cd34 {\n  color: green;\n  /* note */ padding: .5rem;\n}\n.x { margin: 0 0 0 0 }",
    );
    expect(out).toContain(".hero_ab12cd34"); // scoped name intact → SSR/hydration parity
    expect(out).not.toContain("/* note */");
    expect(out).not.toContain("\n");
    expect(out).toContain("margin:0"); // redundancy collapsed (0 0 0 0 → 0)
  });

  test("returns the input unchanged when it can't be parsed (build never breaks)", async () => {
    const garbage = "@@@ this is not valid css @@@";
    expect(await minifyCss(garbage)).toBe(garbage);
  });

  test("with targets: autoprefixes for the target browsers", async () => {
    const out = await minifyCss(".a { user-select: none }", "t.css", { safari: 14 << 16 });
    expect(out).toContain("-webkit-user-select"); // old Safari needs the prefix
    expect(out).toContain("user-select"); // unprefixed kept too
  });

  test("with targets: lowers modern syntax (CSS nesting → flat selectors)", async () => {
    const out = await minifyCss(".x { .y { color: red } }", "t.css", { safari: 14 << 16 });
    expect(out).toContain(".x .y"); // nesting flattened for browsers without it
    expect(out).not.toMatch(/\.x\s*{\s*\.y/); // no nested block survives
  });
});

describe("cssTargets", () => {
  test("resolves usable browser targets (app's browserslist if present, else the baked default)", async () => {
    const t = (await cssTargets(NOCSS_APP)) as Record<string, number>;
    // a valid Lightning targets object — version ints autoprefix/lowering can use.
    // (When `browserslist` is resolvable it drives this; otherwise it's the baked
    // chrome 107 / safari 16 baseline. Either way: real numbers.)
    expect(typeof t.chrome).toBe("number");
    expect(t.chrome).toBeGreaterThan(0);
  });
});

describe("build: content-hashed CSS under /_june/", () => {
  let out: string | undefined;
  afterAll(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  test("global.css is emitted as /_june/global.<hash>.css and linked from the worker", async () => {
    out = await mkdtemp(join(tmpdir(), "june-css-build-"));
    await juneBuild(CSS_ROOT, { outDir: out });

    const files = await readdir(join(out, "assets", "_june"));
    const hashed = files.find((f) => /^global\.[a-f0-9]{8}\.css$/.test(f));
    expect(hashed).toBeTruthy(); // content-hashed name, not the stable /_june/global.css
    const built = await readFile(join(out, "assets", "_june", hashed!), "utf8");
    // raw (non-Tailwind) global.css is minified at build too: whitespace gone and
    // `rebeccapurple` shortened to `#639` by Lightning CSS.
    expect(built).toBe("body{background:#639}");

    // the built worker freezes the HASHED url (not the dev-stable one)
    const worker = await readFile(join(out, "worker.js"), "utf8");
    expect(worker).toContain(`/_june/${hashed}`);
    expect(worker).not.toContain('"/_june/global.css"');
  });
});

describe("immutable cache header for hashed assets", () => {
  const fakeAssets = (body: string, ct: string) => ({
    fetch: async () => new Response(body, { headers: { "content-type": ct } }),
  });
  const passthrough = { fetch: async () => new Response("dynamic") };

  test("content-hashed CSS and JS are served Cache-Control: immutable", async () => {
    const w = withAssets(passthrough);
    const css = await w.fetch(
      new Request("http://x/_june/global.abcd1234.css"),
      { ASSETS: fakeAssets("body{}", "text/css") } as never,
    );
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const js = await w.fetch(
      new Request("http://x/_june/client.abcd1234.js"),
      { ASSETS: fakeAssets("//js", "text/javascript") } as never,
    );
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("a NON-hashed asset is NOT marked immutable (relies on ETag)", async () => {
    const w = withAssets(passthrough);
    const res = await w.fetch(
      new Request("http://x/_june/client.js"),
      { ASSETS: fakeAssets("//js", "text/javascript") } as never,
    );
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
