---
"@junejs/server": patch
---

An optional or catch-all segment (`[[param]]`, `[...rest]`, `[[...rest]]`) must now be the last segment of a route path, as in Next.js (#315). `june build` fails and lists routes such as `[[lang]]/about/page.tsx` or `docs/[...slug]/edit/page.tsx`, and `june dev` reports them at startup. A `(group)` after the segment is still fine.

These shapes had no consistent behavior to keep: `june dev` never matched past a catch-all nor skipped a mid-path `[[param]]` (404), while the built worker's regex did both (200). June does not adopt SvelteKit's reading, where a `[[param]]` is skippable anywhere; the error says so and points a locale prefix at `i18n.locales`.
