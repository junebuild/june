// Per-locale content collections: flat `<dir>/*.md` = default locale, `<dir>/
// <locale>/*.md` = variants, with flat fallback. Tests the resolution functions
// AND the generated _content.ts finder (imported for real), plus the off-by-
// absence guarantee (a flat-only collection emits today's exact shape).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { collection, entry, generateContentModule, scanCollection } from "../src/content";

let root: string; // a content/ dir with two collections: docs (localized) + posts (flat)
const md = (title: string, date: string, h: string) => `---\ntitle: ${title}\ndate: ${date}\n---\n# ${h}\n`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "june-content-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "de"), { recursive: true });
  writeFileSync(join(docs, "intro.md"), md("Intro", "2026-01-01", "Intro EN"));
  writeFileSync(join(docs, "guide.md"), md("Guide", "2026-01-02", "Guide EN"));
  writeFileSync(join(docs, "de", "intro.md"), md("Einführung", "2026-01-01", "Intro DE"));
  // a NON-locale subdir — must not become a phantom locale
  mkdirSync(join(docs, "images"));
  writeFileSync(join(docs, "images", "diagram.md"), md("Diagram", "2026-01-03", "Diagram"));
  const posts = join(root, "posts"); // flat-only collection (no locale subdirs)
  mkdirSync(posts);
  writeFileSync(join(posts, "hello.md"), md("Hello", "2026-02-01", "Hello"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const docsDir = () => join(root, "docs");

describe("scanCollection", () => {
  test("splits flat (default) from <locale>/ subdirs", () => {
    const s = scanCollection(docsDir());
    // non-locale subdirs recurse into nested slugs; date desc (diagram 01-03 > guide 01-02 > intro 01-01)
    expect(s.default.map((e) => e.slug)).toEqual(["images/diagram", "guide", "intro"]);
    expect(s.default.every((e) => e.locale === undefined)).toBe(true);
    expect(Object.keys(s.byLocale)).toEqual(["de"]);
    expect(s.byLocale.de!.map((e) => e.slug)).toEqual(["intro"]);
    expect(s.byLocale.de![0]!.locale).toBe("de");
  });

  test("a flat-only collection has no byLocale", () => {
    expect(Object.keys(scanCollection(join(root, "posts")).byLocale)).toEqual([]);
  });

  test("a non-locale-shaped subdir is NOT a phantom locale", () => {
    // 'images' isn't BCP-47-shaped → ignored; only 'de' is a bucket.
    expect(Object.keys(scanCollection(docsDir()).byLocale)).toEqual(["de"]);
  });

  test("knownLocales restricts buckets to the configured set (exact)", () => {
    expect(Object.keys(scanCollection(docsDir(), ["de"]).byLocale)).toEqual(["de"]);
    // a config without 'de' → 'de/' is not a bucket (treated as non-locale)
    expect(Object.keys(scanCollection(docsDir(), ["fr"]).byLocale)).toEqual([]);
  });
});

describe("collection(dir, locale) — localized listing with fallback", () => {
  test("no locale → the default entries", () => {
    expect(collection(docsDir()).map((e) => e.slug)).toEqual(["images/diagram", "guide", "intro"]);
  });

  test("locale → variant where present, default otherwise", () => {
    const de = collection(docsDir(), "de");
    expect(de.map((e) => e.slug)).toEqual(["images/diagram", "guide", "intro"]);
    expect(de.find((e) => e.slug === "intro")!.locale).toBe("de"); // translated
    expect(de.find((e) => e.slug === "guide")!.locale).toBeUndefined(); // fell back
  });

  test("an untranslated locale falls back wholesale to default", () => {
    expect(collection(docsDir(), "fr").map((e) => e.locale)).toEqual([undefined, undefined, undefined]);
  });
});

describe("entry(dir, slug, locale) — variant else flat", () => {
  test("returns the locale variant when present", () => {
    expect(entry(docsDir(), "intro", "de")!.locale).toBe("de");
    expect(entry(docsDir(), "intro", "de")!.data.title).toBe("Einführung");
  });

  test("falls back to the flat default for an untranslated slug", () => {
    const e = entry(docsDir(), "guide", "de");
    expect(e!.slug).toBe("guide");
    expect(e!.locale).toBeUndefined();
  });

  test("no locale → the flat default", () => {
    expect(entry(docsDir(), "intro")!.data.title).toBe("Intro");
  });

  test("missing slug → null", () => {
    expect(entry(docsDir(), "nope", "de")).toBeNull();
  });

  test("strict (fallback: false) → null instead of default-language bleed", () => {
    expect(entry(docsDir(), "guide", "de", { fallback: false })).toBeNull();
    // a present variant is still returned under strict
    expect(entry(docsDir(), "intro", "de", { fallback: false })!.locale).toBe("de");
  });
});

describe("generateContentModule — the frozen _content.ts", () => {
  test("a localized collection emits the locale map, finder, and lister", () => {
    const { code, names } = generateContentModule(root);
    expect(names.sort()).toEqual(["docs", "posts"]);
    expect(code).toContain("const DOCS_L: Record<string, Record<string, ContentEntry>>");
    expect(code).toContain("export const doc = (slug: string, locale?: string, opts?:");
    expect(code).toContain("export const docs = (locale?: string)");
    expect(code).toContain("locale?: string }"); // the type gained the field
  });

  test("a flat-only collection emits today's exact shape (off by absence)", () => {
    const { code } = generateContentModule(root);
    // posts has no locales → the simple single-arg finder, no POSTS_L.
    expect(code).toContain("export const post = (slug: string): ContentEntry | null => POSTS.find");
    expect(code).not.toContain("POSTS_L");
  });

  test("the emitted finder resolves variant→fallback, the lister merges", async () => {
    const { code } = generateContentModule(root);
    const file = join(root, "_content.ts");
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as {
      doc: (
        slug: string,
        locale?: string,
        opts?: { fallback?: boolean },
      ) => { slug: string; locale?: string } | null;
      docs: (locale?: string) => Array<{ slug: string; locale?: string }>;
      post: (slug: string) => { slug: string } | null;
    };
    expect(mod.doc("intro", "de")!.locale).toBe("de"); // variant
    expect(mod.doc("guide", "de")!.slug).toBe("guide"); // fallback
    expect(mod.doc("guide", "de")!.locale).toBeUndefined();
    expect(mod.doc("guide", "de", { fallback: false })).toBeNull(); // strict
    expect(mod.doc("intro")!.locale).toBeUndefined(); // no locale → default
    expect(mod.docs("de").find((e) => e.slug === "intro")!.locale).toBe("de");
    expect(mod.post("hello")!.slug).toBe("hello"); // flat collection still works
  });
});

// Nested folders → slug paths (`guides/install`), WITH and WITHOUT a locale prefix. Isolated in its
// own temp root so the flat-collection assertions above stay exact.
describe("nested content (folders → slug paths)", () => {
  let nroot: string;
  const ndocs = () => join(nroot, "docs");
  beforeAll(() => {
    nroot = mkdtempSync(join(tmpdir(), "june-nested-"));
    const docs = join(nroot, "docs");
    mkdirSync(join(docs, "guides", "advanced"), { recursive: true });
    mkdirSync(join(docs, "ja-JP", "guides"), { recursive: true });
    writeFileSync(join(docs, "guides", "index.md"), md("Guides", "2026-01-01", "Guides")); // folder index
    writeFileSync(join(docs, "guides", "install.md"), md("Install", "2026-01-02", "Install EN"));
    writeFileSync(join(docs, "guides", "advanced", "tuning.md"), md("Tuning", "2026-01-03", "Tuning EN"));
    writeFileSync(join(docs, "ja-JP", "guides", "install.md"), md("インストール", "2026-01-02", "Install JA"));
  });
  afterAll(() => rmSync(nroot, { recursive: true, force: true }));

  test("scanCollection: nested files get slash slugs; a folder index collapses to the folder", () => {
    const s = scanCollection(ndocs());
    expect(s.default.map((e) => e.slug).sort()).toEqual(["guides", "guides/advanced/tuning", "guides/install"]);
    expect(s.byLocale["ja-JP"]!.map((e) => e.slug)).toEqual(["guides/install"]); // locale mirror nests too
  });

  test("entry: resolves a nested slug with and without a locale (variant → fallback)", () => {
    expect(entry(ndocs(), "guides/install")!.data.title).toBe("Install"); // no locale → default
    expect(entry(ndocs(), "guides/install", "ja-JP")!.locale).toBe("ja-JP"); // nested variant
    expect(entry(ndocs(), "guides/advanced/tuning", "ja-JP")!.locale).toBeUndefined(); // nested fallback
  });

  test("entry: the slug guard allows '/' but rejects path traversal", () => {
    expect(entry(ndocs(), "guides/install")).not.toBeNull(); // '/' allowed
    expect(entry(ndocs(), "../secret")).toBeNull(); // traversal blocked
    expect(entry(ndocs(), "guides/../../etc/passwd")).toBeNull();
    expect(entry(ndocs(), "/guides/install")).toBeNull(); // leading slash → empty segment
  });

  test("the emitted finder resolves nested slugs with/without locale", async () => {
    const { code } = generateContentModule(nroot);
    const file = join(nroot, "_content.ts");
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as {
      doc: (slug: string, locale?: string) => { slug: string; locale?: string } | null;
    };
    expect(mod.doc("guides/advanced/tuning")!.slug).toBe("guides/advanced/tuning"); // 3 levels, no locale
    expect(mod.doc("guides/install", "ja-JP")!.locale).toBe("ja-JP"); // nested variant
    expect(mod.doc("guides/advanced/tuning", "ja-JP")!.locale).toBeUndefined(); // nested fallback
  });
});

describe("html rendering (sparkdown/gfm)", () => {
  // entry.html is rendered by the @momiji-rs/sparkdown/gfm wasm (CommonMark + GFM). This guards the renderer swap
  // from marked: GFM features must render, headings must stay BARE (Kura's anchor post-processor regex
  // depends on `<h2>` with no attributes), and a bare {…} must stay literal text (MDX's expression
  // footgun does not apply to plain markdown).
  let html: string;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "june-md-"));
    writeFileSync(
      join(dir, "p.md"),
      "---\ntitle: T\n---\n" +
        "## Section\n\n" +
        "| a | b |\n|---|---|\n| 1 | 2 |\n\n" +
        "~~old~~ and a bare {literal}\n\n" +
        "- [ ] todo\n- [x] done\n\n" +
        "see https://june.build\n\n" +
        "```ts\nconst x = 1;\n```\n",
    );
    html = collection(dir)[0]!.html;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("GFM table renders", () => expect(html).toContain("<table>"));
  test("GFM strikethrough renders", () => expect(html).toContain("<del>old</del>"));
  test("GFM task list renders", () => expect(html).toContain('type="checkbox"'));
  test("GFM bare-URL autolink renders", () => expect(html).toContain('href="https://june.build"'));
  // Flexible: the contract is "a language-* class is present", so extra classes/whitespace are fine.
  test("code fence keeps the language class", () => expect(html).toMatch(/<code class="[^"]*\blanguage-ts\b/));
  // Strict ON PURPOSE: "bare" IS the contract — Kura's processHtml anchor regex is /<h([23])>/, which
  // only matches an h2/h3 with NO attributes. So assert the exact bare form AND that no h2 carries attrs;
  // a loose match would wrongly pass for a contract-breaking `<h2 id=…>`.
  test("headings stay bare (no injected id/class)", () => {
    expect(html).toContain("<h2>Section</h2>");
    expect(html).not.toMatch(/<h2\s/);
  });
  test("a bare {…} stays literal text (no MDX expression footgun)", () => expect(html).toContain("{literal}"));
});
