// The ICU compiler (phase 3.2): parse at build, evaluate the AST at runtime
// (plural/select via Intl, no shipped parser), and derive param types from the
// same AST.

import { describe, expect, test } from "bun:test";

import { compileCatalog, deriveParams, formatMessage, parseMessage } from "../src/compile";

describe("formatMessage — runtime AST evaluation", () => {
  test("plain interpolation", () => {
    expect(formatMessage(parseMessage("Hi, {name}!"), "en", { name: "Ada" })).toBe("Hi, Ada!");
  });

  test("CLDR plurals (en: one/other)", () => {
    const m = parseMessage("{n, plural, one {# item} other {# items}}");
    expect(formatMessage(m, "en", { n: 1 })).toBe("1 item");
    expect(formatMessage(m, "en", { n: 5 })).toBe("5 items");
  });

  test("exact match (=0) beats the plural category", () => {
    const m = parseMessage("{n, plural, =0 {none} one {# item} other {# items}}");
    expect(formatMessage(m, "en", { n: 0 })).toBe("none");
  });

  test("plurals are locale-correct (zh has only `other`)", () => {
    const m = parseMessage("{n, plural, one {# item} other {# items}}");
    expect(formatMessage(m, "zh", { n: 1 })).toBe("1 items"); // zh → other
  });

  test("select (gender)", () => {
    const m = parseMessage("{g, select, male {he} female {she} other {they}}");
    expect(formatMessage(m, "en", { g: "female" })).toBe("she");
    expect(formatMessage(m, "en", { g: "x" })).toBe("they"); // → other
  });
});

describe("deriveParams — types from the AST (the differentiator)", () => {
  test("plain arg → string, plural var → number", () => {
    expect(deriveParams(parseMessage("Hi, {name}!"))).toEqual({ name: "string" });
    expect(deriveParams(parseMessage("{n, plural, one {#} other {#}}"))).toEqual({ n: "number" });
  });

  test("nested args inside plural/select branches are collected", () => {
    const m = parseMessage("{n, plural, one {{name} has # pt} other {{name} has # pts}}");
    expect(deriveParams(m)).toEqual({ n: "number", name: "string" });
  });

  test("select var is a string", () => {
    expect(deriveParams(parseMessage("{g, select, other {x}}"))).toEqual({ g: "string" });
  });
});

describe("compileCatalog", () => {
  test("parses every entry to an AST array", () => {
    const c = compileCatalog({ a: "x", b: "{n, plural, other {#}}" });
    expect(Array.isArray(c.a)).toBe(true);
    expect(formatMessage(c.b!, "en", { n: 3 })).toBe("3");
  });
});
