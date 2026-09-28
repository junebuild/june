import { defineJune } from "@junejs/core/config";

// A static site under a deploy subpath, with i18n — exercises the static() target's
// prerender-everything branch, <stem>/index.html naming, basePath asset prefixing,
// locale expansion of static routes, and dynamic prerender via staticPaths.
// Uses the `target: "static"` string (no adapter import) — the exact shape Kura
// emits — so build/deploy resolve the built-in staticSite() by name. site.url is
// the public origin (GitHub Pages style: the pages live at <origin>/base/…).
export default defineJune({
  site: { name: "Static App", url: "https://user.example.io" },
  basePath: "/base",
  i18n: { defaultLocale: "en", locales: { en: {}, de: { path: "/de" } } },
  deploy: { target: "static" },
});
