---
"@junejs/core": patch
"@junejs/server": patch
---

An app with no icon of its own now also gets a web app manifest, `/manifest.webmanifest`, linked from every page. It gives Android's "Add to Home Screen" the site name, a short name, the description, 192×192 and 512×512 icons (newly generated alongside the others; the 512 is also marked `maskable`, and a test pins that the glyph's ink stays inside the safe zone), and the theme colour when `resolveThemeColor` yields a single one. `display` is `browser`, so the shortcut opens a normal tab; `standalone` stays opt-in through the app's own manifest.

The short name is the new `site.shortName`, or else the part of `site.name` before " — ", " | ", or ": " ("June — build agents into real apps" → "June"). The pipeline serves the manifest, like the SVG favicon, so dev, the worker, and a static build agree; the static target writes it as a file. An app's own `public/manifest.webmanifest`, `manifest.json`, or `site.webmanifest` is linked instead, and an app with custom icons and no manifest gets none generated. `resolveThemeColor` is now exported from `@junejs/core/document`.
