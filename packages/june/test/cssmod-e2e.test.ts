// CSS Modules end-to-end: a route imports ./Home.module.css. The dev SSR must
// render scoped class names + serve/link the collected sheet; the build must
// emit a hashed sheet + link it + prerender with the SAME scoped names (dev ==
// build, the hydration-safety property).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { juneBuild } from "../src/build";

const APP = fileURLToPath(new URL("./fixtures/cssmod/app", import.meta.url));
const ROOT = dirname(APP);

let out: string | undefined;
afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

describe("CSS Modules e2e", () => {
  test("dev: SSR renders scoped class names, serves + links the collected sheet", async () => {
    const app = createApp({ appDir: APP, config: {} });
    const html = await (await app.fetch(new Request("http://june.test/"))).text();

    const m = html.match(/class="(hero_[a-f0-9]{8})"/);
    expect(m).toBeTruthy(); // the class was scoped, not the literal "hero"
    expect(html).not.toMatch(/class="hero"/);
    expect(html).toContain('<link rel="stylesheet" href="/_june/modules.css"');

    const css = await (await app.fetch(new Request("http://june.test/_june/modules.css"))).text();
    expect(css).toContain(`.${m![1]}`); // the sheet uses the SAME scoped name the SSR used
    expect(css).toContain("color: green");
    expect(css).toContain("padding: .5rem"); // numeric value survived
  });

  test("build: hashed sheet emitted + linked, prerender uses the SAME scoped names", async () => {
    // the dev scoped name, to assert dev == build
    const devApp = createApp({ appDir: APP, config: {} });
    const devHtml = await (await devApp.fetch(new Request("http://june.test/"))).text();
    const devClass = devHtml.match(/class="(hero_[a-f0-9]{8})"/)![1];

    out = await mkdtemp(join(tmpdir(), "june-cssmod-build-"));
    await juneBuild(ROOT, { outDir: out });

    // hashed sheet under /_june/, content-scoped
    const files = await readdir(join(out, "assets", "_june"));
    const sheet = files.find((f) => /^modules\.[a-f0-9]{8}\.css$/.test(f));
    expect(sheet).toBeTruthy();
    const sheetCss = await readFile(join(out, "assets", "_june", sheet!), "utf8");
    expect(sheetCss).toContain(`.${devClass}`); // dev name == build name

    // the prerendered page links the hashed sheet AND uses the same scoped class
    const indexHtml = await readFile(join(out, "assets", "index.html"), "utf8");
    expect(indexHtml).toContain(`class="${devClass}"`);
    expect(indexHtml).toMatch(/<link rel="stylesheet" href="\/_june\/modules\.[a-f0-9]{8}\.css"/);
  });
});
