// The CSS-modules transform: scope every class selector, but NEVER touch class-
// like text inside url()/strings; deterministic so dev/build/client agree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transformCssModule, buildModuleCss, stableKey } from "../src/css-modules";
import { initialize, load } from "../src/css-modules-loader.mjs";

describe("transformCssModule", () => {
  test("scopes a class selector and maps it", () => {
    const { map, css } = transformCssModule(".button { color: red }", "app/x.module.css");
    expect(Object.keys(map)).toEqual(["button"]);
    expect(map.button).toMatch(/^button_[a-f0-9]{8}$/);
    expect(css).toBe(`.${map.button} { color: red }`);
  });

  test("scopes multiple, compound, descendant and pseudo selectors", () => {
    const { map } = transformCssModule(".a .b:hover, .c.d::before { x: y }", "k");
    expect(Object.keys(map).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("does NOT scope class-like text inside url() — file extensions stay intact", () => {
    const { map, css } = transformCssModule(".bg { background: url(hero.png) }", "k");
    expect(Object.keys(map)).toEqual(["bg"]); // only .bg, NOT .png
    expect(css).toContain("url(hero.png)");
  });

  test("does NOT scope class-like text inside strings (content)", () => {
    const { map, css } = transformCssModule('.x::after { content: ".active" }', "k");
    expect(Object.keys(map)).toEqual(["x"]); // not .active
    expect(css).toContain('content: ".active"');
  });

  test("does NOT mistake numeric CSS values for classes or placeholders", () => {
    const { map, css } = transformCssModule(".g { grid-row: 1 / 3; margin: .5rem }", "k");
    expect(Object.keys(map)).toEqual(["g"]);
    expect(css).toContain("grid-row: 1 / 3"); // not corrupted by guard restore
    expect(css).toContain(".5rem"); // digit-led, never a class
  });

  test("strips comments (a `.x` in a comment isn't scoped)", () => {
    const { map } = transformCssModule("/* .ghost */ .real { x: y }", "k");
    expect(Object.keys(map)).toEqual(["real"]);
  });

  test("deterministic: same (key, class) → same name; different key → different name", () => {
    const a = transformCssModule(".btn{}", "app/a.module.css").map.btn;
    const a2 = transformCssModule(".btn{}", "app/a.module.css").map.btn;
    const b = transformCssModule(".btn{}", "app/b.module.css").map.btn;
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
  });

  test("stableKey is app-relative + POSIX (machine-independent)", () => {
    expect(stableKey("/proj", "/proj/app/c/Button.module.css")).toBe("app/c/Button.module.css");
  });
});

describe("buildModuleCss (glob + collect)", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("collects every app/**/*.module.css with maps + combined CSS matching", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app", "ui"), { recursive: true });
    await writeFile(join(dir, "app", "a.module.css"), ".one { color: red }");
    await writeFile(join(dir, "app", "ui", "b.module.css"), ".two { color: blue }");

    const { maps, css } = await buildModuleCss(join(dir, "app"), dir);
    const aMap = maps[join(dir, "app", "a.module.css")]!;
    const bMap = maps[join(dir, "app", "ui", "b.module.css")]!;
    expect(aMap.one).toMatch(/^one_/);
    expect(bMap.two).toMatch(/^two_/);
    // the combined stylesheet uses the SAME scoped names the maps hand out
    expect(css).toContain(`.${aMap.one}`);
    expect(css).toContain(`.${bMap.two}`);
  });

  test("no .module.css → null css", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "page.tsx"), "export default () => null;");
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    expect(css).toBeNull();
  });
});

describe("css-modules-loader.mjs (the Node dev hook)", () => {
  test("a .module.css URL → the precomputed map as a JS module", async () => {
    initialize({ maps: { "/abs/Button.module.css": { btn: "btn_abc12345" } } });
    const r = (await load("file:///abs/Button.module.css", {}, () => {
      throw new Error("should not call next for .module.css");
    })) as { format: string; source: string; shortCircuit: boolean };
    expect(r.format).toBe("module");
    expect(r.source).toContain("btn_abc12345");
    expect(r.shortCircuit).toBe(true);
  });

  test("non-.module.css falls through to next()", async () => {
    let nexted = false;
    await load("file:///x.tsx", {}, () => {
      nexted = true;
      return { ok: true };
    });
    expect(nexted).toBe(true);
  });
});
