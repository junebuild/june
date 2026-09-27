// The default PNG icons: apple-touch-icon.png (180), icon.png (32), and a real
// favicon.ico — the site name's first character on the same dark square as the
// SVG favicon the pipeline serves. Build + dev host only (resvg-wasm, node:fs);
// the worker never imports this, it serves the files `june build` wrote.
//
// A rasterizer has no browser fonts, so each icon picks a font for the script
// of its character:
//   Latin / Greek / Cyrillic caps, digits → Inter caps, bundled (offline, deterministic)
//   Han → the Noto Sans CJK face for site.lang, via CLDR likely subtags:
//         zh → SC, zh-TW / zh-Hant → TC, zh-HK / zh-MO / yue → HK, ja → JP, ko → KR;
//         a lang with no Han signal (en) → SC, CLDR's default for Han
//   kana → Noto Sans JP · Hangul → Noto Sans KR · emoji → Noto Emoji
//   Arabic, Devanagari, Thai, … → that script's Noto Sans face
// Non-bundled faces come from Google Fonts subset to that ONE character (a few
// KB), cached on disk, so only the first build touches the network. Any miss
// (offline, unknown script, a glyph the font lacks) draws the square without a
// character, and never fails the build.
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { DocumentConfig } from "@junejs/core/document";

import { iconLetter } from "./icon-letter";

type Site = DocumentConfig["site"];

export const ICON_BG = "#1d1d1f";
export const ICON_FG = "#fbfbf8";

// Filenames the icons are served at (from the app root), and the public/ files
// that mean the app brings its own icon — then June generates none.
export const GENERATED_ICONS = ["apple-touch-icon.png", "icon.png", "favicon.ico"] as const;
export type GeneratedIconFile = (typeof GENERATED_ICONS)[number];
// The app's own main icon, in preference order: the first one present becomes
// the page's favicon link (so none of them is ever silently unreferenced).
const PRIMARY_ICON_FILES = ["favicon.svg", "icon.svg", "favicon.png", "icon.png", "favicon.ico"];
const CUSTOM_ICON_FILES = [...PRIMARY_ICON_FILES, "apple-touch-icon.png"];

// `inPublic` for resolveIcons over an app's public/ dir. A symlinked public/ is
// ignored, as the build and dev server ignore it.
export function publicFileCheck(publicDir: string): (file: string) => boolean {
  let real = false;
  try {
    real = lstatSync(publicDir).isDirectory();
  } catch {
    /* no public/ */
  }
  return (file) => real && existsSync(join(publicDir, file));
}

// Which icons the document links, and whether June generates them. `inPublic`
// answers whether public/<file> exists. Generated when the app has no icon of
// its own. Otherwise every icon file it has is linked: the first of
// PRIMARY_ICON_FILES as the favicon (site.icon still wins in the document),
// plus icon.png and apple-touch-icon.png when present.
export function resolveIcons(
  site: Site,
  inPublic: (file: string) => boolean,
): { generate: boolean; icons: NonNullable<DocumentConfig["icons"]> } {
  const custom = Boolean(site.icon) || CUSTOM_ICON_FILES.some(inPublic);
  if (!custom) return { generate: true, icons: { png: "/icon.png", appleTouch: "/apple-touch-icon.png" } };
  const primary = PRIMARY_ICON_FILES.find(inPublic);
  return {
    generate: false,
    icons: {
      primary: primary ? `/${primary}` : undefined,
      png: inPublic("icon.png") ? "/icon.png" : undefined,
      appleTouch: inPublic("apple-touch-icon.png") ? "/apple-touch-icon.png" : undefined,
    },
  };
}

const is = (re: RegExp) => (ch: string) => re.test(ch);
const isBundled = is(/^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}0-9•]/u);
const isEmoji = is(/^\p{Extended_Pictographic}/u);
const isKana = is(/^[\p{Script=Hiragana}\p{Script=Katakana}]/u);
const isHangul = is(/^\p{Script=Hangul}/u);
const isHan = is(/^\p{Script=Han}/u);

// Scripts with a Noto Sans face on Google Fonts, by Unicode script name.
const NOTO_SCRIPTS = [
  "Arabic", "Armenian", "Bengali", "Devanagari", "Ethiopic", "Georgian", "Gujarati", "Gurmukhi",
  "Hebrew", "Kannada", "Khmer", "Lao", "Malayalam", "Myanmar", "Sinhala", "Tamil", "Telugu", "Thai",
] as const;
const NOTO_SCRIPT_RES = NOTO_SCRIPTS.map((s) => [s, new RegExp(`^\\p{Script=${s}}`, "u")] as const);

// The Noto Sans CJK face whose Han glyph forms match `lang`. Resolved through
// CLDR likely subtags (Intl.Locale#maximize) instead of a hand-picked region.
export function hanFamily(lang: string | undefined): string {
  let loc: Intl.Locale;
  try {
    loc = new Intl.Locale(lang || "und").maximize();
  } catch {
    return "Noto Sans SC";
  }
  if (loc.script === "Jpan") return "Noto Sans JP";
  if (loc.script === "Kore") return "Noto Sans KR";
  if (loc.script === "Hant") return loc.region === "HK" || loc.region === "MO" ? "Noto Sans HK" : "Noto Sans TC";
  return "Noto Sans SC"; // Hans, or a language with no Han signal — CLDR's und-Hani is zh-Hans
}

// The Google Fonts family for a character; null = the bundled Inter caps;
// undefined = no known face (draw the square alone).
export function iconFamily(ch: string, lang: string | undefined): string | null | undefined {
  if (!ch) return undefined;
  if (isBundled(ch)) return null;
  if (isEmoji(ch)) return "Noto Emoji";
  if (isKana(ch)) return "Noto Sans JP";
  if (isHangul(ch)) return "Noto Sans KR";
  if (isHan(ch)) return hanFamily(lang);
  const script = NOTO_SCRIPT_RES.find(([, re]) => re.test(ch))?.[0];
  return script ? `Noto Sans ${script}` : undefined;
}

// Fetches a font subset: resolves to the TTF bytes, or null on any failure.
export type FontFetcher = (family: string, text: string) => Promise<Uint8Array | null>;

// A legacy Safari UA makes Google Fonts answer with TTF (resvg reads TTF/OTF,
// not woff2) — the same trick @junejs/og uses.
const LEGACY_UA =
  "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";

// Google Fonts, subset to `text`, cached under cacheDir by request URL so a
// rebuild never refetches. timeoutMs bounds each request (offline builds fall
// back quickly instead of hanging).
export function googleFontFetcher(
  cacheDir: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): FontFetcher {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  return async (family, text) => {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@600&text=${encodeURIComponent(text)}`;
    const file = join(cacheDir, createHash("sha256").update(cssUrl).digest("hex").slice(0, 32) + ".ttf");
    try {
      return new Uint8Array(await readFile(file));
    } catch {
      /* not cached */
    }
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const cssRes = await doFetch(cssUrl, { headers: { "User-Agent": LEGACY_UA }, signal });
      if (!cssRes.ok) return null;
      const url = (await cssRes.text()).match(/src: url\((.+?)\)/)?.[1];
      if (!url) return null;
      const fontRes = await doFetch(url, { signal });
      if (!fontRes.ok) return null;
      const bytes = new Uint8Array(await fontRes.arrayBuffer());
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, bytes);
      return bytes;
    } catch {
      return null;
    }
  };
}

type ResvgModule = typeof import("@resvg/resvg-wasm");
let resvgReady: Promise<ResvgModule> | undefined;
function loadResvg(): Promise<ResvgModule> {
  return (resvgReady ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    const wasmPath = createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");
    await mod.initWasm(await readFile(wasmPath));
    return mod;
  })());
}

let bundledFont: Promise<Uint8Array> | undefined;
const loadBundledFont = () =>
  (bundledFont ??= readFile(new URL("../assets/icon-latin.ttf", import.meta.url)).then((b) => new Uint8Array(b)));
const BUNDLED_FAMILY = "Inter";

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Where the glyph goes on the 64×64 square: font size + origin, from its INK
// box — not its em box — so every script sits optically centred at one size.
// A probe render measures the ink; cap height and a CJK ideograph both come out
// INK_H tall, and a wide glyph is held to INK_W.
const PROBE = 1000;
const INK_H = 28;
const INK_W = 40;
type Placement = { family: string; font: Uint8Array; size: number; x: number; y: number };

function inkBox(resvg: ResvgModule, ch: string, family: string, font: Uint8Array) {
  const probe =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PROBE}" height="${PROBE}">` +
    `<text x="${PROBE / 2}" y="${PROBE * 0.7}" font-family="${family}" font-size="${PROBE * 0.6}">${escapeXml(ch)}</text></svg>`;
  const r = new resvg.Resvg(probe, { font: { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: family } });
  const bbox = r.getBBox();
  const box = bbox && bbox.width > 0 && bbox.height > 0 ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null;
  bbox?.free();
  r.free();
  return box;
}

// A private-use code point no subset font maps: whatever it draws is .notdef.
const NOTDEF_PROBE = "";

function place(resvg: ResvgModule, ch: string, family: string, font: Uint8Array): Placement | null {
  const bbox = inkBox(resvg, ch, family, font);
  if (!bbox) return null;
  // A font without the glyph draws .notdef (tofu), which HAS ink — so compare
  // with the font's own .notdef box. The same box means a missing glyph.
  const notdef = inkBox(resvg, NOTDEF_PROBE, family, font);
  if (notdef && notdef.x === bbox.x && notdef.y === bbox.y && notdef.width === bbox.width && notdef.height === bbox.height) {
    return null;
  }
  const scale = Math.min(INK_H / bbox.height, INK_W / bbox.width);
  const cx = bbox.x + bbox.width / 2 - PROBE / 2;
  const cy = bbox.y + bbox.height / 2 - PROBE * 0.7;
  return { family, font, size: PROBE * 0.6 * scale, x: 32 - cx * scale, y: 32 - cy * scale };
}

// The icon as SVG on a 64 grid. rounded=false for apple-touch-icon: iOS masks
// the corners itself and wants a full-bleed square.
function iconSvg(ch: string, p: Placement | null, rounded: boolean): string {
  const glyph = p
    ? `<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" font-family="${p.family}" font-size="${p.size.toFixed(2)}" fill="${ICON_FG}">${escapeXml(ch)}</text>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<rect width="64" height="64"${rounded ? ` rx="12"` : ""} fill="${ICON_BG}"/>${glyph}</svg>`
  );
}

// A single-image .ico whose entry is a PNG (valid since Windows Vista; every
// current browser reads it).
export function pngToIco(png: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22 + png.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true); // type: icon
  v.setUint16(4, 1, true); // one image
  out[6] = size >= 256 ? 0 : size; // width
  out[7] = size >= 256 ? 0 : size; // height
  v.setUint16(10, 1, true); // colour planes
  v.setUint16(12, 32, true); // bits per pixel
  v.setUint32(14, png.length, true);
  v.setUint32(18, 22, true); // image data offset
  out.set(png, 22);
  return out;
}

export type GeneratedIcons = {
  "apple-touch-icon.png": Uint8Array<ArrayBuffer>;
  "icon.png": Uint8Array<ArrayBuffer>;
  "favicon.ico": Uint8Array<ArrayBuffer>;
  // What was drawn, for the build log and tests: the character and its font
  // family, or family null when the square went out without one.
  letter: string;
  family: string | null;
};

export async function renderIcons(opts: {
  site: Site;
  fetchFont: FontFetcher;
  warn?: (msg: string) => void;
}): Promise<GeneratedIcons> {
  const resvg = await loadResvg();
  const ch = iconLetter(opts.site.name);
  const family = iconFamily(ch, opts.site.lang);
  let placement: Placement | null = null;
  if (family === null) {
    placement = place(resvg, ch, BUNDLED_FAMILY, await loadBundledFont());
  } else if (family !== undefined) {
    const font = await opts.fetchFont(family, ch);
    if (font) placement = place(resvg, ch, family, font);
  }
  if (ch && !placement) {
    opts.warn?.(
      `[june] default icon: no font for "${ch}"${family ? ` (${family} unavailable — offline?)` : ""}; ` +
        `drew the square without it. Set site.icon or add public/icon.png to use your own.`,
    );
  }
  const fonts = placement ? [placement.font] : [];
  const render = (size: number, rounded: boolean) => {
    const r = new resvg.Resvg(iconSvg(ch, placement, rounded), {
      fitTo: { mode: "width", value: size },
      font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: placement?.family ?? BUNDLED_FAMILY },
    });
    const image = r.render();
    const png = image.asPng() as Uint8Array<ArrayBuffer>; // a JS-owned copy, not a view into wasm memory
    image.free();
    r.free();
    return png;
  };
  const icon32 = render(32, true);
  return {
    "apple-touch-icon.png": render(180, false),
    "icon.png": icon32,
    "favicon.ico": pngToIco(icon32, 32),
    letter: ch,
    family: placement?.family ?? null,
  };
}
