// @junejs/i18n — ICU messages, the OPT-IN Layer 2 of June's i18n (routing is the
// in-box Layer 1; see docs/i18n.md §Packaging). Ambient `t`: read the current
// request locale off the scope (no ctx threading) and format the catalog message.
//
//   import { defineMessages, compileCatalog, t } from "@junejs/i18n";
//   defineMessages(
//     { en: compileCatalog({ hi: "Hello, {name}!" }),
//       de: compileCatalog({ hi: "Hallo, {name}!" }) },
//     { defaultLocale: "en" },
//   );
//   t("hi", { name: "Ada" });   // server: reads ctx.locale via the request scope
//
// The catalogs ship COMPILED (parsed ASTs) — the @formatjs parser runs at build,
// never in the request path (see compile.ts). A build step will generate the
// defineMessages call + the typed `t` signature from `messages/*.json` (3.2b).

// currentLocale is the generic request-scope read (the host sets it after locale
// resolution); the core pipeline never imports this package — the locale crosses
// via the scope, not a direct dependency.
import { currentLocale } from "@junejs/db";

import { formatMessage, type CompiledCatalog } from "./compile";

// parseMessage / compileCatalog / formatMessage / deriveParams + the AST types.
export * from "./compile";

export type MessagesConfig = {
  catalogs: Record<string, CompiledCatalog>;
  defaultLocale: string;
};

let registry: MessagesConfig | null = null;

/** Register the compiled message catalogs (called once at app boot). A build step
 *  generates this call — with compiled ASTs — from `messages/*.json`. */
export function defineMessages(
  catalogs: Record<string, CompiledCatalog>,
  opts: { defaultLocale: string },
): void {
  registry = { catalogs, defaultLocale: opts.defaultLocale };
}

const warn = (msg: string) => {
  // Tree-shaken out of production bundles (NODE_ENV baked at build).
  if (process.env.NODE_ENV !== "production") console.warn(`[june i18n] ${msg}`);
};

/** A pure translator bound to a locale + compiled catalogs. The fallback chain is
 *  variant → default locale → the key itself (dev-warns on a miss). Exposed for
 *  tests and for non-ambient use (islands receive a translator built from props). */
export function createTranslator(
  locale: string,
  catalogs: Record<string, CompiledCatalog>,
  defaultLocale: string,
): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const msg = catalogs[locale]?.[key] ?? catalogs[defaultLocale]?.[key];
    if (msg === undefined) {
      warn(`missing key "${key}" (locale "${locale}")`);
      return key;
    }
    return formatMessage(msg, locale, params);
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
