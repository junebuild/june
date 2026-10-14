---
"@junejs/server": patch
---

`june build` for Workers now gives wrangler a loader for the font and image files your worker imports (#379). Before, a worker that imported a `.otf`, such as `@junejs/pdf-font-noto-sans-tc`'s, built fine but failed `wrangler deploy` with `No loader is configured for ".otf" files`. The build already left those files for wrangler to load, but wrangler only loads `.wasm` by default.

- The generated `wrangler.jsonc` gets one `Data` rule for the extensions the bundle actually imports (`.ttf`, `.otf`, `.woff`, `.woff2`, `.png`, `.jpg`, `.jpeg`, `.avif`, `.webp`). The rule sets `fallthrough: true`, so wrangler's default rules still apply. An app that imports none of these gets the same config as before.
- If you keep your own `wrangler.jsonc` / `wrangler.toml`, June still leaves it untouched. It now warns when the config has no rule for an imported extension and prints the rule to add.
- If you added the rule by hand for the font package, you can remove it from a June-generated config. Keep it in your own config.
