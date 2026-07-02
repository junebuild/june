---
"@junejs/server": patch
---

Locale buckets are now DECLARED, not guessed — `content/docs/cli/` is content, not a locale

The content freeze detected locale mirrors by folder shape (a BCP-47-ish regex), so ANY
2–3-letter top-level folder — `cli/`, `sdk/`, `api/`, `faq/`, `dev/` … — was silently treated
as a locale bucket and dropped from the default set (its pages never reached `app/_content.ts`).

`june gen` now takes the locale set from config `i18n` (defaultLocale + `locales` keys):

- Only declared dirs split off as locale mirrors; everything else is content.
- **No `i18n` config ⇒ no locale buckets at all** — an undeclared locale is not a locale. If you
  relied on shape-detected mirrors without declaring `i18n`, declare it.
- The shape regex remains only as the fallback when june.config.ts itself cannot be loaded
  (the wrapper-CLI bootstrap pass), and the bootstrap re-probe carries the declared set.

`scanCollection`/`collection`/`entry`'s optional `knownLocales` parameter semantics are
unchanged; the fix is that the freeze now actually passes it.
