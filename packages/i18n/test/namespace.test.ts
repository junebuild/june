// 3.5 DX: namespaced catalogs (messages/<locale>/<ns>.json → ns.key) merged with
// flat files, and deduped missing-key warnings.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMessages } from "../src/codegen";
import { __resetMessages, createTranslator } from "../src/index";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "june-ns-"));
  writeFileSync(join(dir, "en.json"), JSON.stringify({ title: "Home" })); // flat root key
  mkdirSync(join(dir, "en"));
  writeFileSync(join(dir, "en", "cart.json"), JSON.stringify({ items: "{n} items", empty: "Empty" }));
  mkdirSync(join(dir, "de"));
  writeFileSync(join(dir, "de", "cart.json"), JSON.stringify({ items: "{n} Artikel" }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("namespacing", () => {
  test("a subdir file prefixes its keys with the filename; flat files merge in", () => {
    const { catalogs, locales } = loadMessages(dir);
    expect(locales.sort()).toEqual(["de", "en"]);
    expect(Object.keys(catalogs.en!).sort()).toEqual(["cart.empty", "cart.items", "title"]);
    expect(Object.keys(catalogs.de!)).toEqual(["cart.items"]);

    const t = createTranslator("de", catalogs, "en");
    expect(t("cart.items", { n: 3 })).toBe("3 Artikel"); // de namespace
    expect(t("cart.empty")).toBe("Empty"); // en fallback
    expect(t("title")).toBe("Home"); // flat root key
  });
});

describe("deduped missing-key warnings", () => {
  test("a missing key warns once, not per call", () => {
    __resetMessages(); // clears the dedup set
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      const t = createTranslator("en", { en: {} }, "en");
      t("nope");
      t("nope");
      t("nope");
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes('missing key "nope"'))).toHaveLength(1);
  });
});
