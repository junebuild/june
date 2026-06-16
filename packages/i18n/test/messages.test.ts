// The runtime t (phase 3.1): {param} interpolation, the fallback chain, and the
// ambient read of the request-scope locale (the seam that lets `t` work in a
// loader/action without threading ctx).

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureScope, runInScope, setRequestLocale } from "@junejs/db";

import { __resetMessages, createTranslator, defineMessages, t } from "../src/index";
import { compileCatalog } from "../src/compile"; // build-time parse (not in the runtime index)

// Catalogs ship COMPILED (parsed ASTs); compileCatalog is the build-time parse.
const catalogs = {
  en: compileCatalog({ hi: "Hello, {name}!", bye: "Bye" }),
  de: compileCatalog({ hi: "Hallo, {name}!" }), // no `bye` → falls back to en
};

describe("createTranslator (pure)", () => {
  const t = createTranslator("de", catalogs, "en");

  test("interpolates {param}", () => {
    expect(t("hi", { name: "Ada" })).toBe("Hallo, Ada!");
  });

  test("falls back to the default locale for a missing key", () => {
    expect(t("bye")).toBe("Bye"); // de has no `bye` → en
  });

  test("falls back to the key itself when absent everywhere", () => {
    expect(t("nope")).toBe("nope");
  });

  test("a missing param is left visible, not thrown", () => {
    expect(t("hi")).toBe("Hallo, {name}!");
  });
});

describe("ambient t (reads the request-scope locale)", () => {
  beforeAll(() => ensureScope());
  beforeEach(() => {
    __resetMessages();
    defineMessages(catalogs, { defaultLocale: "en" });
  });

  const inLocale = <T,>(locale: string | undefined, fn: () => T): Promise<T> | T =>
    runInScope({ resources: {} }, () => {
      if (locale) setRequestLocale(locale);
      return fn();
    });

  test("formats in the scope's locale", () => {
    expect(inLocale("de", () => t("hi", { name: "Ada" }))).toBe("Hallo, Ada!");
    expect(inLocale("en", () => t("hi", { name: "Ada" }))).toBe("Hello, Ada!");
  });

  test("no locale in scope → the default locale", () => {
    expect(inLocale(undefined, () => t("hi", { name: "Ada" }))).toBe("Hello, Ada!");
  });

  test("the fallback chain works through the ambient path too", () => {
    expect(inLocale("de", () => t("bye"))).toBe("Bye"); // de→en
  });
});
