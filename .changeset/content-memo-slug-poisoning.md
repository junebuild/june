---
"@junejs/server": patch
---

Fix fresh-build slug flattening: key the content-entry memo by (file, slug, locale), not file alone. The bootstrap two-pass in generateContent scans the same files twice in one process (pass 1 with regex-guessed locales, pass 2 with the declared set); the file-keyed memo handed pass 1's entry (where a 2-3 letter folder like docs/adr/ was mistaken for a locale bucket, producing flat slugs) back to pass 2, freezing wrong slugs into app/_content.ts on every fresh CI build while warm local builds looked correct.
