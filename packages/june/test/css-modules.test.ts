// The CSS-modules transform (Lightning CSS + our stable scoping key): scope every
// local class, honor :global / composes (BY REFERENCE — composed rules are not
// inlined, so they appear once with no dedup pass), normalize url()/strings safely,
// and stay deterministic so dev/build/client/Node agree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transformCssModule, buildModuleCss, stableKey } from "../src/css-modules";
import { minifyCss } from "../src/css";
import { initialize, load } from "../src/css-modules-loader.mjs";

describe("transformCssModule", () => {
  let dir: string;
  // Each transform reads a real file (cross-file `composes` resolves the referenced
  // file from disk), so tests write a fixture and transform it.
  const transform = async (name: string, css: string, appRoot = dir) => {
    await writeFile(join(dir, name), css);
    return transformCssModule(join(dir, name), appRoot);
  };
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  // mkdtemp per test via a getter-ish: set dir lazily in each test.
  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
  };

  test("scopes a class selector and maps it", async () => {
    await setup();
    const { map, css } = await transform("x.module.css", ".button { color: red }");
    expect(Object.keys(map)).toEqual(["button"]);
    expect(map.button).toMatch(/^button_[A-Za-z0-9_-]+$/); // local_<hash>, Lightning's hash
    expect(css).toContain(`.${map.button}`);
    expect(css).toContain("color: red");
  });

  test("scopes multiple, compound, descendant and pseudo selectors", async () => {
    await setup();
    const { map } = await transform("m.module.css", ".a .b:hover, .c.d::before { x: y }");
    expect(Object.keys(map).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test(":global(...) is left unscoped", async () => {
    await setup();
    const { map, css } = await transform(
      "g.module.css",
      ".local { x: y } :global(.no-scope) { a: b }",
    );
    expect(Object.keys(map)).toEqual(["local"]); // .no-scope is NOT a local
    expect(css).toContain(".no-scope {"); // emitted verbatim, unscoped
    expect(css).toContain(`.${map.local}`);
  });

  test("composes (cross-file) merges names by REFERENCE — the rule is not inlined", async () => {
    await setup();
    await writeFile(join(dir, "base.module.css"), ".pad { padding: 4px }");
    const { map, css } = await transform(
      "btn.module.css",
      '.btn { composes: pad from "./base.module.css"; color: red }',
    );
    // styles.btn === "btn_<hash> pad_<hash>" — both classes applied
    const parts = map.btn!.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^btn_[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^pad_[A-Za-z0-9_-]+$/);
    // the composed rule is NOT inlined here — it lives in base.module.css (so the
    // combined sheet gets it once). This file only has its own declarations.
    expect(css).toContain("color: red");
    expect(css).not.toContain("padding: 4px");
  });

  test("does NOT scope class-like text inside url() — file extensions stay intact", async () => {
    await setup();
    const { map, css } = await transform("u.module.css", ".bg { background: url(hero.png) }");
    expect(Object.keys(map)).toEqual(["bg"]); // only .bg, NOT .png
    expect(css).toContain('url("hero.png")'); // Lightning quotes urls; .png intact, not scoped
  });

  test("does NOT scope class-like text inside strings (content)", async () => {
    await setup();
    const { map, css } = await transform("s.module.css", '.x::after { content: ".active" }');
    expect(Object.keys(map)).toEqual(["x"]); // not .active
    expect(css).toContain('content: ".active"');
  });

  test("does NOT mistake numeric CSS values for classes", async () => {
    await setup();
    const { map, css } = await transform("n.module.css", ".g { grid-row: 1 / 3; margin: .5rem }");
    expect(Object.keys(map)).toEqual(["g"]);
    expect(css).toContain("grid-row: 1 / 3");
    expect(css).toContain(".5rem");
  });

  test("deterministic: same (key, class) → same name; different file → different name", async () => {
    await setup();
    const a = (await transform("a.module.css", ".btn{ x: y }")).map.btn;
    const a2 = (await transform("a.module.css", ".btn{ x: y }")).map.btn;
    const b = (await transform("b.module.css", ".btn{ x: y }")).map.btn;
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

  test("a rule composed from N files appears ONCE in the combined sheet (like Vite)", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "base.module.css"), ".base { color: red }");
    await writeFile(
      join(dir, "app", "a.module.css"),
      '.btn { composes: base from "./base.module.css"; font-weight: bold }',
    );
    await writeFile(
      join(dir, "app", "b.module.css"),
      '.card { composes: base from "./base.module.css"; border: 1px }',
    );
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    // base is composed by a + b AND emitted directly → would be ×3 without dedup
    expect((css!.match(/color: red/g) ?? []).length).toBe(1);
    // the composers' own rules survive
    expect(css).toContain("font-weight: bold");
    expect(css).toContain("border: 1px");
  });

  test("interleaved :global rules preserve cascade (the last one wins)", async () => {
    // :global lets two files emit the same raw selector. Sorted a,b,c gives the
    // cascade [red, blue, red]; the LAST (red) must win. We no longer dedup the
    // sheet (Lightning references composes, so there's nothing to collapse here) —
    // file order IS source order, so the cascade is correct by construction.
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "a.module.css"), ":global(.g) { color: red }");
    await writeFile(join(dir, "app", "b.module.css"), ":global(.g) { color: blue }");
    await writeFile(join(dir, "app", "c.module.css"), ":global(.g) { color: red }");
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    // red appears after blue → red wins, exactly as authored
    expect(css!.lastIndexOf("color: red")).toBeGreaterThan(css!.lastIndexOf("color: blue"));
  });

  test("identical :global rules across files collapse at BUILD (Lightning minify)", async () => {
    // The dev/raw sheet keeps both (readable, deterministic); the build's minifyCss
    // pass — already in the pipeline — collapses byte-identical rules. No custom
    // dedup pass, no postcss.
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "a.module.css"), ":global(.reset) { margin: 0 }");
    await writeFile(join(dir, "app", "b.module.css"), ":global(.reset) { margin: 0 }");
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    const minified = await minifyCss(css!, "modules.css");
    expect((minified.match(/margin/g) ?? []).length).toBe(1); // two copies → one
  });

  test("minify collapses identical @media blocks, keeps distinct ones", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    const block = "@media (min-width: 600px) { :global(.w) { display: grid } }";
    await writeFile(join(dir, "app", "a.module.css"), block);
    await writeFile(join(dir, "app", "b.module.css"), block); // identical
    await writeFile(
      join(dir, "app", "c.module.css"),
      "@media (min-width: 900px) { :global(.w) { display: flex } }", // distinct
    );
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    const minified = await minifyCss(css!, "modules.css");
    // identical 600px blocks → one (Lightning also modernizes min-width → width>=)
    expect((minified.match(/600px/g) ?? []).length).toBe(1);
    expect(minified).toContain("grid");
    expect(minified).toContain("flex"); // distinct 900px @media kept
  });

  test("genuinely different declarations on the same selector both survive", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "a.module.css"), ":global(.h) { color: red }");
    await writeFile(join(dir, "app", "b.module.css"), ":global(.h) { color: green }");
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    expect(css).toContain("color: red");
    expect(css).toContain("color: green"); // both survive — genuinely different
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
