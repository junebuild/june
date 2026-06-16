// The BUILD-time compiler: parse to AST + derive param types from it.

import { describe, expect, test } from "bun:test";

import { compileCatalog, deriveParams, parseMessage } from "../src/compile";
import { formatMessage } from "../src/format";

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
