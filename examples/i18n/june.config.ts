import { defineJune } from "@junejs/core/config";

// The i18n fixture: unified locale routing (a default + a sub-path locale + a
// domain locale), per-locale content, and the agent/SEO surfaces that follow.
export default defineJune({
  site: {
    name: "June i18n",
    titleTemplate: "%s · June i18n",
    lang: "en", // the floor; ctx.locale overrides it per request
  },
  i18n: {
    defaultLocale: "en",
    locales: {
      en: {}, // default origin, unprefixed "/"
      de: { path: "/de" }, // sub-path on the default origin
      fr: { domain: "june-fr.example" }, // a dedicated domain (hreflang/sitemap demo)
    },
  },
});
