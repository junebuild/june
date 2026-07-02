import { defineJune } from "@junejs/core/config";
import { staticSite } from "@junejs/server";

// A static site under a deploy subpath, with i18n — exercises the static() target's
// prerender-everything branch, <stem>/index.html naming, basePath asset prefixing,
// locale expansion of static routes, and dynamic prerender via staticPaths.
export default defineJune({
  site: { name: "Static App" },
  basePath: "/base",
  i18n: { defaultLocale: "en", locales: { en: {}, de: { path: "/de" } } },
  deploy: { adapter: staticSite() },
});
