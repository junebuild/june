// The default PNG icons: which character, which font per script (CJK by
// site.lang through CLDR), the Google Fonts fetcher's cache/fallback, and the
// rendered bytes. No network: every fetch is stubbed.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  googleFontFetcher,
  hanFamily,
  iconFamily,
  pngToIco,
  renderIcons,
  resolveIcons,
  type FontFetcher,
} from "../src/favicon";
import { iconLetter } from "../src/icon-letter";

const pngSize = (png: Uint8Array) => {
  const v = new DataView(png.buffer, png.byteOffset);
  return [v.getUint32(16), v.getUint32(20)]; // IHDR width, height
};
const offline: FontFetcher = async () => null;

describe("iconLetter()", () => {
  test("the first grapheme, uppercased — whole even outside the BMP", () => {
    expect(iconLetter("june")).toBe("J");
    expect(iconLetter("  éclair")).toBe("É");
    expect(iconLetter("🚀 launch")).toBe("🚀");
    expect(iconLetter("🇹🇼 flag")).toBe("🇹🇼"); // two code points, one grapheme
    expect(iconLetter("𠀋abc")).toBe("𠀋"); // a surrogate pair, not half of one
    expect(iconLetter("   ")).toBe("");
    expect(iconLetter(undefined)).toBe("");
  });
});

describe("hanFamily() — Han glyph forms follow site.lang via CLDR, not a guessed region", () => {
  test.each([
    ["zh", "Noto Sans SC"],
    ["zh-CN", "Noto Sans SC"],
    ["zh-SG", "Noto Sans SC"],
    ["zh-Hans", "Noto Sans SC"],
    ["zh-TW", "Noto Sans TC"],
    ["zh-Hant", "Noto Sans TC"],
    ["zh-HK", "Noto Sans HK"],
    ["zh-MO", "Noto Sans HK"],
    ["yue", "Noto Sans HK"],
    ["ja", "Noto Sans JP"],
    ["ko", "Noto Sans KR"],
    // No Han signal in the language: CLDR's default for Han (und-Hani → zh-Hans).
    ["en", "Noto Sans SC"],
    [undefined, "Noto Sans SC"],
    ["not a locale!", "Noto Sans SC"],
  ])("%s → %s", (lang, family) => {
    expect(hanFamily(lang)).toBe(family);
  });
});

describe("iconFamily() — one font per script", () => {
  test("Latin, Greek, Cyrillic caps and digits use the bundled font (null)", () => {
    for (const ch of ["J", "É", "Ω", "Я", "7"]) expect(iconFamily(ch, "en")).toBeNull();
  });
  test("CJK scripts", () => {
    expect(iconFamily("骨", "zh-TW")).toBe("Noto Sans TC");
    expect(iconFamily("骨", "ja")).toBe("Noto Sans JP");
    expect(iconFamily("あ", "en")).toBe("Noto Sans JP"); // kana is Japanese whatever the lang
    expect(iconFamily("ア", "zh-TW")).toBe("Noto Sans JP");
    expect(iconFamily("한", "en")).toBe("Noto Sans KR");
  });
  test("other scripts get their Noto Sans face; emoji get Noto Emoji", () => {
    expect(iconFamily("ب", "ar")).toBe("Noto Sans Arabic");
    expect(iconFamily("क", "hi")).toBe("Noto Sans Devanagari");
    expect(iconFamily("ไ", "th")).toBe("Noto Sans Thai");
    expect(iconFamily("א", "he")).toBe("Noto Sans Hebrew");
    expect(iconFamily("🚀", "en")).toBe("Noto Emoji");
  });
  test("no character, or a script with no known face → undefined (square only)", () => {
    expect(iconFamily("", "en")).toBeUndefined();
    expect(iconFamily("ᚠ", "en")).toBeUndefined(); // Runic
  });
});

describe("resolveIcons()", () => {
  const none = () => false;
  test("no icon of the app's own → June generates and links both PNGs", () => {
    expect(resolveIcons({ name: "Acme" }, none)).toEqual({
      generate: true,
      icons: { png: "/icon.png", appleTouch: "/apple-touch-icon.png" },
    });
  });
  test("site.icon or any public/ icon → generate nothing", () => {
    expect(resolveIcons({ icon: "/brand.svg" }, none).generate).toBe(false);
    for (const f of ["favicon.ico", "favicon.svg", "icon.png", "apple-touch-icon.png"]) {
      expect(resolveIcons({}, (x) => x === f).generate).toBe(false);
    }
  });
  test("every icon file the app brings is linked — none suppresses generation unreferenced", () => {
    const has = (...files: string[]) => (x: string) => files.includes(x);
    expect(resolveIcons({}, has("apple-touch-icon.png", "favicon.ico")).icons).toEqual({
      primary: "/favicon.ico",
      png: undefined,
      appleTouch: "/apple-touch-icon.png",
    });
    // favicon.png / icon.svg become the page's favicon (not June's letter SVG).
    expect(resolveIcons({}, has("favicon.png")).icons.primary).toBe("/favicon.png");
    expect(resolveIcons({}, has("icon.svg")).icons.primary).toBe("/icon.svg");
    // SVG is preferred when several are present.
    expect(resolveIcons({}, has("favicon.ico", "icon.png", "favicon.svg")).icons.primary).toBe("/favicon.svg");
    // Only an apple-touch-icon: no primary → the letter SVG stays the favicon.
    expect(resolveIcons({}, has("apple-touch-icon.png")).icons.primary).toBeUndefined();
  });
});

describe("pngToIco()", () => {
  test("a single-entry ICO header in front of the PNG", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const ico = pngToIco(png, 32);
    const v = new DataView(ico.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 1]);
    expect([ico[6], ico[7]]).toEqual([32, 32]);
    expect(v.getUint32(14, true)).toBe(png.length);
    expect(v.getUint32(18, true)).toBe(22);
    expect(ico.slice(22)).toEqual(png);
  });
});

describe("renderIcons()", () => {
  test("a Latin name renders with the bundled font — sizes 180 / 32, ico wraps the 32", async () => {
    const icons = await renderIcons({ site: { name: "June" }, fetchFont: offline });
    expect(icons.letter).toBe("J");
    expect(icons.family).toBe("Inter");
    expect(pngSize(icons["apple-touch-icon.png"])).toEqual([180, 180]);
    expect(pngSize(icons["icon.png"])).toEqual([32, 32]);
    expect(icons["favicon.ico"].slice(22)).toEqual(icons["icon.png"]);
  });

  test("a CJK name asks for that ONE character in the site.lang face", async () => {
    const asked: Array<[string, string]> = [];
    const warnings: string[] = [];
    const icons = await renderIcons({
      site: { name: "骨董市集", lang: "zh-TW" },
      fetchFont: async (family, text) => {
        asked.push([family, text]);
        return null; // offline
      },
      warn: (m) => warnings.push(m),
    });
    expect(asked).toEqual([["Noto Sans TC", "骨"]]);
    // Offline: the square goes out without the character, with a warning — never a failure.
    expect(icons.family).toBeNull();
    expect(pngSize(icons["apple-touch-icon.png"])).toEqual([180, 180]);
    expect(warnings[0]).toContain("Noto Sans TC unavailable");
  });

  test("a font without the glyph is a miss, not a blank glyph", async () => {
    const warnings: string[] = [];
    // Bundled Inter has no Han; hand it over as if Google had returned it.
    const inter = new Uint8Array(await Bun.file(new URL("../assets/icon-latin.ttf", import.meta.url)).arrayBuffer());
    const icons = await renderIcons({ site: { name: "骨" }, fetchFont: async () => inter, warn: (m) => warnings.push(m) });
    expect(icons.family).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test("deterministic: the same site renders the same bytes", async () => {
    const a = await renderIcons({ site: { name: "Acme" }, fetchFont: offline });
    const b = await renderIcons({ site: { name: "Acme" }, fetchFont: offline });
    expect(a["icon.png"]).toEqual(b["icon.png"]);
  });
});

describe("googleFontFetcher()", () => {
  const css = "@font-face { src: url(https://fonts.gstatic.com/x.ttf) format('truetype'); }";
  const stub = (calls: string[], fail = false) =>
    (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (fail) throw new Error("offline");
      return String(input).includes("googleapis") ? new Response(css) : new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;

  test("subsets to the text, then serves the cached file without refetching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-fonts-"));
    const calls: string[] = [];
    const fetchFont = googleFontFetcher(dir, { fetch: stub(calls) });
    expect(await fetchFont("Noto Sans TC", "骨")).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0]).toContain("family=Noto%20Sans%20TC:wght@600&text=%E9%AA%A8");
    expect(calls).toHaveLength(2);
    expect(await fetchFont("Noto Sans TC", "骨")).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(2); // disk cache hit
    expect(await readdir(dir)).toHaveLength(1);
  });

  test("any failure resolves null (the caller falls back), and nothing is cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-fonts-"));
    const fetchFont = googleFontFetcher(dir, { fetch: stub([], true) });
    expect(await fetchFont("Noto Sans KR", "한")).toBeNull();
    expect(await readdir(dir)).toHaveLength(0);
  });
});
