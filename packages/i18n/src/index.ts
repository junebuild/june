// @junejs/i18n — ICU messages, the OPT-IN Layer 2 of June's i18n (routing is the
// in-box Layer 1; see docs/i18n.md §Packaging). Ambient `t`: read the current
// request locale off the scope (no ctx threading) and format the catalog message.
//
//   import { defineMessages, t } from "@junejs/i18n";
//   defineMessages({ en: { hi: "Hello, {name}!" }, de: { hi: "Hallo, {name}!" } },
//                  { defaultLocale: "en" });
//   t("hi", { name: "Ada" });   // server: reads ctx.locale via the request scope
//
// PHASE 3.1 (this): the seam + runtime `t` with {param} interpolation + the
// fallback chain. Full ICU (plurals/select) compiled at build + TYPE-DERIVED
// params land in 3.2 (the @formatjs parser, build-time only). Until then a
// message like "{n, plural, …}" is passed through verbatim.

// currentLocale is the generic request-scope read (the host sets it after locale
// resolution); the core pipeline never imports this package — the locale crosses
// via the scope, not a direct dependency.
import { currentLocale } from "@junejs/db";

/** A locale's messages: key → ICU MessageFormat string. */
export type MessageCatalog = Record<string, string>;

export type MessagesConfig = {
  catalogs: Record<string, MessageCatalog>;
  defaultLocale: string;
};

let registry: MessagesConfig | null = null;

/** Register the message catalogs (called once at app boot, like a data layer's
 *  install). A later build step will generate this call from `messages/*.json`. */
export function defineMessages(
  catalogs: Record<string, MessageCatalog>,
  opts: { defaultLocale: string },
): void {
  registry = { catalogs, defaultLocale: opts.defaultLocale };
}

// MVP formatter: `{name}` interpolation only. A missing param is left as `{name}`
// (visible in dev) rather than throwing. Full ICU is the 3.2 compiler.
function interpolate(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) =>
    params && key in params ? String(params[key]) : `{${key}}`,
  );
}

const warn = (msg: string) => {
  // Tree-shaken out of production bundles (NODE_ENV baked at build).
  if (process.env.NODE_ENV !== "production") console.warn(`[june i18n] ${msg}`);
};

/** A pure translator bound to a locale + catalogs. The fallback chain is
 *  variant → default locale → the key itself (dev-warns on a miss). Exposed for
 *  tests and for non-ambient use (islands receive a translator built from props). */
export function createTranslator(
  locale: string,
  catalogs: Record<string, MessageCatalog>,
  defaultLocale: string,
): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template = catalogs[locale]?.[key] ?? catalogs[defaultLocale]?.[key];
    if (template === undefined) {
      warn(`missing key "${key}" (locale "${locale}")`);
      return key;
    }
    return interpolate(template, params);
  };
}

/** Ambient translate: resolves the locale from the request scope (`ctx.locale`),
 *  then formats `key` from the registered catalogs. Falls back to the default
 *  locale, then the key. Server-side (loaders/views/actions); islands take a
 *  translator via props instead (no scope on the client). */
export function t(key: string, params?: Record<string, unknown>): string {
  if (!registry) {
    warn(`t("${key}") called before defineMessages()`);
    return key;
  }
  const locale = currentLocale() ?? registry.defaultLocale;
  return createTranslator(locale, registry.catalogs, registry.defaultLocale)(key, params);
}

// Test-only: reset the module registry between cases.
export function __resetMessages(): void {
  registry = null;
}
