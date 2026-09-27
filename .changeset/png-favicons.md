---
"@junejs/core": patch
"@junejs/server": patch
---

An app with no icon of its own now also gets PNG icons: `icon.png` (32×32, for Google Search, which doesn't show SVG favicons), `apple-touch-icon.png` (180×180, for iOS home screens), and a real `favicon.ico`. Before, only the letter SVG existed, and `/favicon.ico` returned that SVG. `june build` rasterizes them into `dist/assets/` with `@resvg/resvg-wasm`, `june dev` renders them on first request with the same code, and the document links them (new `DocumentConfig.icons`).

The font follows the script of the site name's first character, taken as a grapheme so emoji and characters outside the BMP stay whole; the SVG favicon now uses the same rule instead of `charAt(0)`. Latin, Greek, Cyrillic, and digits use a bundled Inter subset (34 KB, OFL), so they need no network. Han uses the Noto Sans CJK face matching `site.lang` through CLDR likely subtags (`zh` → SC, `zh-TW` → TC, `zh-HK` → HK, `ja` → JP, `ko` → KR; no Han signal → SC, CLDR's default). Kana, Hangul, emoji, and scripts such as Arabic or Devanagari get their own Noto faces. Those come from Google Fonts subset to the one character and are cached in `node_modules/.cache/june/fonts`. A glyph the font lacks is detected rather than drawn as tofu. Offline or unknown scripts draw the square without the character and print a warning; they never fail the build. `site.icon` or an icon file in `public/` turns generation off.
