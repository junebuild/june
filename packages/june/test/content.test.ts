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
  const posts = join(root, "posts"); // flat-only collection (no locale subdirs)
  mkdirSync(posts);
  writeFileSync(join(posts, "hello.md"), md("Hello", "2026-02-01", "Hello"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const docsDir = () => join(root, "docs");

describe("scanCollection", () => {
  test("splits flat (default) from <locale>/ subdirs", () => {
    const s = scanCollection(docsDir());
    expect(s.default.map((e) => e.slug)).toEqual(["guide", "intro"]); // date desc
    expect(s.default.every((e) => e.locale === undefined)).toBe(true);
    expect(Object.keys(s.byLocale)).toEqual(["de"]);
    expect(s.byLocale.de!.map((e) => e.slug)).toEqual(["intro"]);
    expect(s.byLocale.de![0]!.locale).toBe("de");
  });

  test("a flat-only collection has no byLocale", () => {
    expect(Object.keys(scanCollection(join(root, "posts")).byLocale)).toEqual([]);
  });
});

describe("collection(dir, locale) — localized listing with fallback", () => {
  test("no locale → the default entries", () => {
    expect(collection(docsDir()).map((e) => e.slug)).toEqual(["guide", "intro"]);
  });

  test("locale → variant where present, default otherwise", () => {
    const de = collection(docsDir(), "de");
    expect(de.map((e) => e.slug)).toEqual(["guide", "intro"]);
    expect(de.find((e) => e.slug === "intro")!.locale).toBe("de"); // translated
    expect(de.find((e) => e.slug === "guide")!.locale).toBeUndefined(); // fell back
  });

  test("an untranslated locale falls back wholesale to default", () => {
    expect(collection(docsDir(), "fr").map((e) => e.locale)).toEqual([undefined, undefined]);
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
