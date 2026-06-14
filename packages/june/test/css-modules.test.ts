// The CSS-modules transform (postcss-modules + our deterministic scoper): scope
// every local class, honor :global / composes, never touch url()/strings, and
// stay deterministic so dev/build/client/Node agree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transformCssModule, buildModuleCss, stableKey } from "../src/css-modules";
import { initialize, load } from "../src/css-modules-loader.mjs";

describe("transformCssModule", () => {
  let dir: string;
  // Each transform reads a real file (postcss-modules needs `from` to resolve
  // composes), so tests write a fixture and transform it.
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
    expect(map.button).toMatch(/^button_[a-f0-9]{8}$/);
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

  test("composes pulls in the referenced class (cross-file) and merges names", async () => {
    await setup();
    await writeFile(join(dir, "base.module.css"), ".pad { padding: 4px }");
    const { map, css } = await transform(
      "btn.module.css",
      '.btn { composes: pad from "./base.module.css"; color: red }',
    );
    // styles.btn === "btn_<hash> pad_<hash>" — both classes applied
    const parts = map.btn!.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^btn_[a-f0-9]{8}$/);
    expect(parts[1]).toMatch(/^pad_[a-f0-9]{8}$/);
    // the composed rule is inlined into this file's output
    expect(css).toContain(`.${parts[1]}`);
    expect(css).toContain("padding: 4px");
  });

  test("does NOT scope class-like text inside url() — file extensions stay intact", async () => {
    await setup();
    const { map, css } = await transform("u.module.css", ".bg { background: url(hero.png) }");
    expect(Object.keys(map)).toEqual(["bg"]); // only .bg, NOT .png
    expect(css).toContain("url(hero.png)");
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

  test("dedup preserves cascade: keeps the LAST of interleaved identical rules", async () => {
    // :global lets two files emit the same raw selector. Sorted a,b,c gives the
    // cascade [red, blue, red]; the last (red) must keep winning. Keep-first dedup
    // would drop c's red and let blue win — a behavior change. Keep-last is safe.
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "a.module.css"), ":global(.g) { color: red }");
    await writeFile(join(dir, "app", "b.module.css"), ":global(.g) { color: blue }");
    await writeFile(join(dir, "app", "c.module.css"), ":global(.g) { color: red }");
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    expect((css!.match(/color: red/g) ?? []).length).toBe(1); // a's red deduped away
    expect((css!.match(/color: blue/g) ?? []).length).toBe(1);
    // red still comes AFTER blue → red wins, exactly as in the un-deduped cascade
    expect(css!.indexOf("color: red")).toBeGreaterThan(css!.indexOf("color: blue"));
  });

  test("dedup collapses identical :global rules across files to one copy", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "a.module.css"), ":global(.reset) { margin: 0 }");
    await writeFile(join(dir, "app", "b.module.css"), ":global(.reset) { margin: 0 }");
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    expect((css!.match(/margin: 0/g) ?? []).length).toBe(1);
  });

  test("dedup handles @media blocks: identical collapsed, distinct kept", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-cssm-"));
    await mkdir(join(dir, "app"), { recursive: true });
    const block = "@media (min-width: 600px) { :global(.w) { display: grid } }";
    await writeFile(join(dir, "app", "a.module.css"), block);
    await writeFile(join(dir, "app", "b.module.css"), block); // identical → one
    await writeFile(
      join(dir, "app", "c.module.css"),
      "@media (min-width: 900px) { :global(.w) { display: flex } }", // distinct → kept
    );
    const { css } = await buildModuleCss(join(dir, "app"), dir);
    expect((css!.match(/display: grid/g) ?? []).length).toBe(1);
    expect((css!.match(/min-width: 600px/g) ?? []).length).toBe(1);
    expect(css).toContain("display: flex");
    expect(css).toContain("min-width: 900px");
  });

  test("dedup does NOT collapse same selector with different declarations", async () => {
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
