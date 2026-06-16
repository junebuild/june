# June i18n example

The i18n stack end-to-end on one app:

- **Unified locale routing** (`june.config.ts`): a default locale (`en`, at `/`),
  a sub-path locale (`de`, at `/de`), and a domain locale (`fr`, on its own host).
- **`ctx.locale`** resolved from the URL — `/de/docs/intro` → `"de"`.
- **Per-locale content**: `content/docs/intro.md` (default) + `content/docs/de/intro.md`
  (variant). The generated finder `doc(slug, ctx.locale)` returns the variant when
  present, else falls back to the default file.
- **Dynamic `<html lang>`** and **`hreflang` alternates** in the document head,
  plus `xhtml:link` alternates in `/sitemap.xml` — emitted automatically.
- **`localeHref`** builds the locale switcher on the home page.

The agent surfaces stay canonical single-language by design: a page's `.md`/`.json`
follow its locale, but `/llms.txt` and `/mcp` are not translated.

```
bun run --filter @june-examples/i18n dev   # or: cd examples/i18n && june dev
```
