// The pure host-resolution layer: inbound resolve (domain / path / subdomain /
// mixed), the ambiguous-case negotiation chain, and outbound localeHref. These
// functions are the single source of truth for both dev and the built worker, so
// they carry the real coverage for i18n routing.

import { describe, expect, test } from "bun:test";

import {
  type I18nConfig,
  localeHref,
  matchPinnedLocale,
  negotiateLocale,
  parseAcceptLanguage,
  resolveRequestLocale,
} from "../src/i18n";

// The canonical mixed config from docs/i18n.md — one table, every URL shape.
const i18n: I18nConfig = {
  defaultLocale: "en",
  prefixDefaultLocale: false,
  locales: {
    en: {}, // default origin, unprefixed "/"
    de: { path: "/de" }, // sub-path
    fr: { domain: "example.fr" }, // dedicated domain
    ja: { domain: "ja.example.com" }, // subdomain
    "zh-TW": { domain: "example.com.tw", path: "/tw" }, // mixed
  },
};

describe("matchPinnedLocale — URL pins the locale", () => {
  test("sub-path on the default origin strips its prefix", () => {
    expect(matchPinnedLocale(i18n, "example.com", "/de/about")).toEqual({
      locale: "de",
      pathname: "/about",
      pinned: true,
    });
  });

  test("sub-path root collapses to '/'", () => {
    expect(matchPinnedLocale(i18n, "example.com", "/de")).toEqual({
      locale: "de",
      pathname: "/",
      pinned: true,
    });
  });

  test("dedicated domain pins the locale, pathname untouched", () => {
    expect(matchPinnedLocale(i18n, "example.fr", "/about")).toEqual({
      locale: "fr",
      pathname: "/about",
      pinned: true,
    });
  });

  test("subdomain pins the locale", () => {
    expect(matchPinnedLocale(i18n, "ja.example.com", "/posts/x")).toEqual({
      locale: "ja",
      pathname: "/posts/x",
      pinned: true,
    });
  });

  test("mixed (domain + path) strips the path on its domain", () => {
    expect(matchPinnedLocale(i18n, "example.com.tw", "/tw/about")).toEqual({
      locale: "zh-TW",
      pathname: "/about",
      pinned: true,
    });
  });

  test("mixed domain without its path still pins via the domain", () => {
    // The domain decides; an absent path prefix just means nothing to strip.
    expect(matchPinnedLocale(i18n, "example.com.tw", "/about")).toEqual({
      locale: "zh-TW",
      pathname: "/about",
      pinned: true,
    });
  });

  test("host is case-insensitive and port is ignored (dev)", () => {
    expect(matchPinnedLocale(i18n, "Example.FR:3000", "/x")?.locale).toBe("fr");
  });

  test("a bare path on the default origin is ambiguous → null", () => {
    expect(matchPinnedLocale(i18n, "example.com", "/about")).toBeNull();
    expect(matchPinnedLocale(i18n, "example.com", "/")).toBeNull();
  });

  test("a prefix only matches on a segment boundary (no '/desktop' for '/de')", () => {
    expect(matchPinnedLocale(i18n, "example.com", "/desktop")).toBeNull();
  });

  test("longest prefix wins when paths nest", () => {
    const nested: I18nConfig = {
      defaultLocale: "en",
      locales: { en: {}, zh: { path: "/zh" }, "zh-TW": { path: "/zh/tw" } },
    };
    expect(matchPinnedLocale(nested, "example.com", "/zh/tw/x")).toEqual({
      locale: "zh-TW",
      pathname: "/x",
      pinned: true,
    });
    expect(matchPinnedLocale(nested, "example.com", "/zh/x")?.locale).toBe("zh");
  });

  test("prefixDefaultLocale pins '/en' to the default and leaves bare paths ambiguous", () => {
    const pref: I18nConfig = {
      defaultLocale: "en",
      prefixDefaultLocale: true,
      locales: { en: {}, de: { path: "/de" } },
    };
    expect(matchPinnedLocale(pref, "example.com", "/en/about")).toEqual({
      locale: "en",
      pathname: "/about",
      pinned: true,
    });
    expect(matchPinnedLocale(pref, "example.com", "/about")).toBeNull();
  });
});

describe("parseAcceptLanguage", () => {
  test("orders tags by descending q and lowercases", () => {
    expect(parseAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5")).toEqual([
      "fr-ch",
      "fr",
      "en",
      "de",
      "*",
    ]);
  });

  test("empty / missing header → []", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

describe("negotiateLocale — the ambiguous-case chain", () => {
  test("a valid cookie wins (case-insensitive)", () => {
    expect(negotiateLocale(i18n, { cookie: "zh-tw", acceptLanguage: "de" })).toBe("zh-TW");
  });

  test("an unconfigured cookie is ignored, falls to Accept-Language", () => {
    expect(negotiateLocale(i18n, { cookie: "xx", acceptLanguage: "de,en" })).toBe("de");
  });

  test("primary-subtag match (de-AT → de)", () => {
    expect(negotiateLocale(i18n, { acceptLanguage: "de-AT;q=1, en;q=0.5" })).toBe("de");
  });

  test("matches a configured region tag via its primary subtag (zh → zh-TW)", () => {
    expect(negotiateLocale(i18n, { acceptLanguage: "zh" })).toBe("zh-TW");
  });

  test("no signal → defaultLocale", () => {
    expect(negotiateLocale(i18n, {})).toBe("en");
    expect(negotiateLocale(i18n, { acceptLanguage: "xx,yy" })).toBe("en");
  });
});

describe("resolveRequestLocale — pinned else negotiated", () => {
  test("URL pin beats negotiation signals", () => {
    expect(
      resolveRequestLocale(i18n, { host: "example.fr", pathname: "/x", cookie: "de" }),
    ).toEqual({ locale: "fr", pathname: "/x", pinned: true });
  });

  test("ambiguous → negotiation, pathname preserved", () => {
    expect(
      resolveRequestLocale(i18n, { host: "example.com", pathname: "/about", acceptLanguage: "de" }),
    ).toEqual({ locale: "de", pathname: "/about", pinned: false });
  });

  test("a valid override (resolveLocale hook) wins over negotiation", () => {
    expect(
      resolveRequestLocale(i18n, {
        host: "example.com",
        pathname: "/",
        acceptLanguage: "de",
        override: "ja",
      }),
    ).toEqual({ locale: "ja", pathname: "/", pinned: false });
  });

  test("an invalid override is ignored", () => {
    expect(
      resolveRequestLocale(i18n, { host: "example.com", pathname: "/", override: "xx" }).locale,
    ).toBe("en");
  });
});

describe("localeHref — outbound, symmetric with the table", () => {
  test("default locale is unprefixed", () => {
    expect(localeHref(i18n, "/about", "en")).toBe("/about");
  });

  test("sub-path locale prepends its prefix", () => {
    expect(localeHref(i18n, "/about", "de")).toBe("/de/about");
    expect(localeHref(i18n, "/", "de")).toBe("/de");
  });

  test("cross-domain locale produces an absolute URL", () => {
    expect(localeHref(i18n, "/about", "fr", { currentHost: "example.com" })).toBe(
      "https://example.fr/about",
    );
  });

  test("same-domain stays relative (no needless absolute)", () => {
    expect(localeHref(i18n, "/about", "fr", { currentHost: "example.fr" })).toBe("/about");
  });

  test("mixed locale gets domain + path", () => {
    expect(localeHref(i18n, "/about", "zh-TW", { currentHost: "example.com" })).toBe(
      "https://example.com.tw/tw/about",
    );
  });

  test("protocol override (dev)", () => {
    expect(
      localeHref(i18n, "/x", "ja", { currentHost: "example.com", protocol: "http" }),
    ).toBe("http://ja.example.com/x");
  });

  test("unknown locale is a no-op", () => {
    expect(localeHref(i18n, "/about", "xx")).toBe("/about");
  });

  test("prefixDefaultLocale prefixes the default too", () => {
    const pref: I18nConfig = {
      defaultLocale: "en",
      prefixDefaultLocale: true,
      locales: { en: {}, de: { path: "/de" } },
    };
    expect(localeHref(pref, "/about", "en")).toBe("/en/about");
  });
});
