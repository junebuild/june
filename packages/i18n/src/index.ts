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
import type { ReactNode } from "react";

import { currentLocale } from "@junejs/db";

// Runtime only — format.ts/rich.ts do NOT reach the @formatjs parser (that's
// build-only in compile.ts / codegen.ts), so the request bundle never ships one.
import { formatMessage, type CompiledCatalog, type CompiledMessage } from "./format";
import { formatRich } from "./rich";

export { formatMessage, type CompiledCatalog, type CompiledMessage } from "./format";
export { formatRich } from "./rich";

/** A translator: callable for a plain string, `.rich` for embedded components. */
export type Translator = {
  (key: string, params?: Record<string, unknown>): string;
  rich(key: string, params?: Record<string, unknown>): ReactNode;
};

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
): Translator {
  const lookup = (key: string): CompiledMessage | undefined =>
    catalogs[locale]?.[key] ?? catalogs[defaultLocale]?.[key];
  const tr = ((key, params) => {
    const msg = lookup(key);
    if (msg === undefined) {
      warn(`missing key "${key}" (locale "${locale}")`);
      return key;
    }
    return formatMessage(msg, locale, params);
  }) as Translator;
  tr.rich = (key, params) => {
    const msg = lookup(key);
    if (msg === undefined) {
      warn(`missing key "${key}" (locale "${locale}")`);
      return key; // a string ReactNode
    }
    return formatRich(msg, locale, params);
  };
  return tr;
}

function ambientTranslator(): Translator | null {
  if (!registry) return null;
  return createTranslator(
    currentLocale() ?? registry.defaultLocale,
    registry.catalogs,
    registry.defaultLocale,
  );
}

/** Ambient translate: resolves the locale from the request scope (`ctx.locale`),
 *  then formats `key` from the registered catalogs. Falls back to the default
 *  locale, then the key. `t.rich` renders embedded `<tag>`s to ReactNode. Server-
 *  side (loaders/views/actions); islands take a translator via props instead. */
export const t: Translator = Object.assign(
  (key: string, params?: Record<string, unknown>): string => {
    const tr = ambientTranslator();
    if (!tr) {
      warn(`t("${key}") called before defineMessages()`);
      return key;
    }
    return tr(key, params);
  },
  {
    rich: (key: string, params?: Record<string, unknown>): ReactNode => {
      const tr = ambientTranslator();
      if (!tr) {
        warn(`t.rich("${key}") called before defineMessages()`);
        return key;
      }
      return tr.rich(key, params);
    },
  },
);

// Test-only: reset the module registry between cases.
export function __resetMessages(): void {
  registry = null;
}
