// Runtime AST evaluation (format.ts): the parser-free path that ships. ASTs are
// produced by parseMessage (build) for the test.

import { describe, expect, test } from "bun:test";

import { parseMessage } from "../src/compile";
import { formatMessage } from "../src/format";

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
