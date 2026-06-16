// i18n — the NEUTRAL host-resolution layer (i18n is its first consumer;
// multi-tenancy is the second — see docs/multi-tenancy.md). PURE and node-free:
// the dev server, the built worker, and `june build` all import THESE functions,
// so inbound resolution and outbound link generation can never drift apart.
//
// The whole feature is off by absence: with no `i18n` in june.config.ts the
// pipeline never calls any of this (one `if (cfg.i18n)` guard) and it tree-shakes
// out. This is Layer 1 (routing) only — the message catalog (ICU `t()`) is a
// separate opt-in concern (a future @junejs/i18n), never bound to routing.

// A locale's URL home. Either or both:
//   { path: "/de" }                         sub-path on the default origin
//   { domain: "example.fr" }                a dedicated domain (any TLD)
//   { domain: "ja.example.com" }            a subdomain
//   { domain: "example.com.tw", path: "/tw" } mixed: domain + sub-path
// A non-default locale with NEITHER is unreachable (it has no URL home).
export type LocaleConfig = {
  domain?: string;
  path?: string;
};

export type I18nConfig = {
  defaultLocale: string;
  // Each locale declares its URL home; the same table drives inbound resolution
  // AND outbound localeHref (symmetric by construction).
  locales: Record<string, LocaleConfig>;
  // false (default): the default locale is unprefixed/canonical at "/".
  // true: the default locale also lives under "/<defaultLocale>"; a bare path is
  // ambiguous and negotiates.
  prefixDefaultLocale?: boolean;
  // Called ONLY for the ambiguous case (the URL pins no locale — a bare path on
  // the default origin). Return a locale to force it, undefined to fall through
  // to built-in negotiation (Accept-Language → cookie → defaultLocale). A config
  // hook, not _middleware: locale resolution must run before routing and feed
  // ctx.locale — the framework does that; the hook only picks the locale.
  resolveLocale?: (req: { url: URL; headers: Headers }) => string | undefined;
};

// The cookie the built-in negotiation chain reads/writes for a returning visitor.
export const LOCALE_COOKIE = "june-locale";

export type LocaleMatch = {
  locale: string;
  // The route pathname with the locale's domain/path stripped — what the router
  // matches. ("/de/about" under locale `de {path:"/de"}` → "/about".)
  pathname: string;
  // true when the URL itself pinned the locale (domain or path); false when it
  // was negotiated (the ambiguous bare-path case).
  pinned: boolean;
};

// The URL prefix a locale occupies on its origin. Explicit `path` wins; the
// default locale gets an implicit "/<locale>" only when prefixDefaultLocale is on;
// everything else is unprefixed ("" = the origin root).
function effectivePath(i18n: I18nConfig, locale: string): string {
  const explicit = i18n.locales[locale]?.path;
  if (explicit) return explicit;
  if (locale === i18n.defaultLocale && i18n.prefixDefaultLocale) {
    return `/${locale}`;
  }
  return "";
}

// Does `pathname` live under the prefix `p`? "" matches everything (origin root);
// a non-empty prefix matches its exact path or any sub-path, never a longer
// sibling ("/de" matches "/de" and "/de/x", NOT "/desktop").
function underPrefix(pathname: string, p: string): boolean {
  if (p === "") return true;
  return pathname === p || pathname.startsWith(p + "/");
}

function stripPrefix(pathname: string, p: string): string {
  if (p === "") return pathname;
  return pathname.slice(p.length) || "/";
}

const hostNoPort = (host: string): string => host.toLowerCase().split(":")[0]!;

// INBOUND, URL-pinned only. Returns the locale the URL itself pins (by domain or
// path), or null when the URL is ambiguous (a bare path on the default origin →
// the caller negotiates). This is the non-overridable routing contract.
export function matchPinnedLocale(
  i18n: I18nConfig,
  host: string,
  pathname: string,
): LocaleMatch | null {
  const h = hostNoPort(host);
  const entries = Object.keys(i18n.locales);

  // Locales whose dedicated domain IS this host. A domain match pins the locale
  // even if its path prefix isn't present (the domain decides).
  const onDomain = entries.filter((name) => i18n.locales[name]!.domain?.toLowerCase() === h);
  if (onDomain.length) {
    const matched = longestUnder(i18n, onDomain, pathname);
    if (matched) return matched;
    // The domain pins its locale; with multiple path-locales sharing the domain,
    // prefer the one with no prefix (the domain's base), else the first declared.
    const base = onDomain.find((name) => effectivePath(i18n, name) === "") ?? onDomain[0]!;
    return { locale: base, pathname, pinned: true };
  }

  // Not a declared domain → the default origin. Only a NON-EMPTY path prefix pins
  // here; a bare path ("" would match every locale) is ambiguous → null.
  const onDefaultOrigin = entries.filter((name) => !i18n.locales[name]!.domain);
  const matched = longestUnder(i18n, onDefaultOrigin, pathname, /* requirePrefix */ true);
  return matched;
}

// Among `names`, the locale whose effectivePath is the LONGEST prefix of pathname
// (so "/zh/tw" beats "/zh"). With requirePrefix, the empty "" prefix is excluded
// (used on the default origin, where "" is the ambiguous case, not a pin).
function longestUnder(
  i18n: I18nConfig,
  names: string[],
  pathname: string,
  requirePrefix = false,
): LocaleMatch | null {
  let best: { locale: string; p: string } | null = null;
  for (const name of names) {
    const p = effectivePath(i18n, name);
    if (requirePrefix && p === "") continue;
    if (!underPrefix(pathname, p)) continue;
    if (!best || p.length > best.p.length) best = { locale: name, p };
  }
  if (!best) return null;
  return { locale: best.locale, pathname: stripPrefix(pathname, best.p), pinned: true };
}

// "fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5" → ["fr-ch","fr","en","*"] by descending q.
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}

// The ambiguous-case fallback chain: a valid `june-locale` cookie → the best
// Accept-Language match (exact, then primary subtag) → defaultLocale. Returns a
// configured locale NAME (original casing). Pure — the pipeline reads the cookie
// and header off the request and passes them in.
export function negotiateLocale(
  i18n: I18nConfig,
  input: { acceptLanguage?: string | null; cookie?: string | null } = {},
): string {
  // lowercased configured tag → its original-cased name, for case-insensitive match.
  const byLower = new Map<string, string>();
  for (const name of Object.keys(i18n.locales)) byLower.set(name.toLowerCase(), name);

  const cookie = input.cookie?.toLowerCase();
  if (cookie && byLower.has(cookie)) return byLower.get(cookie)!;

  for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
    if (byLower.has(tag)) return byLower.get(tag)!; // exact (e.g. "zh-tw")
    const primary = tag.split("-")[0]!; // "fr-ch" → "fr"
    if (byLower.has(primary)) return byLower.get(primary)!;
    const namePrimaryMatch = [...byLower.keys()].find((k) => k.split("-")[0] === primary);
    if (namePrimaryMatch) return byLower.get(namePrimaryMatch)!;
  }
  return i18n.defaultLocale;
}

// INBOUND, full resolution. Pins from the URL when it can; otherwise takes the
// `override` (a resolveLocale-hook result, already validated by the caller) or
// negotiates. The pathname is only rewritten when a prefix was actually stripped.
export function resolveRequestLocale(
  i18n: I18nConfig,
  input: {
    host: string;
    pathname: string;
    acceptLanguage?: string | null;
    cookie?: string | null;
    override?: string;
  },
): LocaleMatch {
  const pinned = matchPinnedLocale(i18n, input.host, input.pathname);
  if (pinned) return pinned;
  const override = input.override && i18n.locales[input.override] ? input.override : undefined;
  const locale = override ?? negotiateLocale(i18n, input);
  return { locale, pathname: input.pathname, pinned: false };
}

// OUTBOUND. Build a URL for `path` (a route path with NO locale prefix) in
// `locale`: prepend the locale's path prefix, and make it an absolute URL when the
// locale lives on a different domain than `currentHost` (a cross-origin locale
// switcher / hreflang must be absolute). The SAME `locales` table that resolved
// inbound drives this — symmetric.
export function localeHref(
  i18n: I18nConfig,
  path: string,
  locale: string,
  opts: { currentHost?: string; protocol?: string } = {},
): string {
  const loc = i18n.locales[locale];
  if (!loc) return path; // unknown locale: no-op rather than throw

  const prefix = effectivePath(i18n, locale);
  // "/de" + "/about" → "/de/about"; "/de" + "/" → "/de" (no dangling slash).
  const target = path === "/" ? prefix || "/" : `${prefix}${path}`;

  if (loc.domain && loc.domain.toLowerCase() !== opts.currentHost?.toLowerCase()) {
    return `${opts.protocol ?? "https"}://${loc.domain}${target}`;
  }
  return target;
}
