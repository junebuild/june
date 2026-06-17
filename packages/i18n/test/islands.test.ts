// Client code-split: pickMessages (server subset) + clientTranslator (format that
// subset on the client, no scope). The seam that lets an island ship only its own
// messages while a page ships none.

import { beforeEach, describe, expect, test } from "bun:test";

import { compileCatalog } from "../src/compile";
import { __resetMessages, clientTranslator, defineMessages, pickMessages } from "../src/index";

const catalogs = {
  en: compileCatalog({ a: "A {x}", b: "B", c: "C" }),
  de: compileCatalog({ a: "DE-A {x}" }), // only `a` is translated
};

beforeEach(() => {
  __resetMessages();
  defineMessages(catalogs, { defaultLocale: "en" });
});

describe("pickMessages — the island subset", () => {
  test("only the requested keys, in the given locale, with per-key fallback", () => {
    const sub = pickMessages(["a", "b"], "de");
    expect(Object.keys(sub).sort()).toEqual(["a", "b"]);
    // verify provenance through a translator: a = de variant, b = en fallback
    const t = clientTranslator(sub, "de");
    expect(t("a", { x: 5 })).toBe("DE-A 5");
    expect(t("b")).toBe("B");
    expect(Object.keys(sub)).not.toContain("c"); // not requested → not shipped
  });

  test("a missing key is omitted (not shipped)", () => {
    expect(Object.keys(pickMessages(["a", "nope"], "en"))).toEqual(["a"]);
  });

  test("before defineMessages → empty", () => {
    __resetMessages();
    expect(pickMessages(["a"], "en")).toEqual({});
  });
});

describe("clientTranslator — format a subset without the scope", () => {
  test("interpolation + plural from a flat one-locale catalog", () => {
    const messages = compileCatalog({
      hi: "Hi {name}",
      items: "{n, plural, one {# item} other {# items}}",
    });
    const t = clientTranslator(messages, "en");
    expect(t("hi", { name: "Ada" })).toBe("Hi Ada");
    expect(t("items", { n: 2 })).toBe("2 items");
  });
});
