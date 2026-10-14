// The generated Bidi_Class table (scripts/gen-bidi.ts): well formed, and right where it
// matters for picking a paragraph's direction.

import { describe, expect, test } from "bun:test";

import { STRONG, UNICODE_VERSION } from "../src/bidi-classes";

function classOf(cp: number): "L" | "R" | undefined {
  for (let i = 0; i < STRONG.length; i += 3) if (cp >= STRONG[i]! && cp <= STRONG[i + 1]!) return STRONG[i + 2] ? "R" : "L";
  return undefined;
}

describe("bidi-classes", () => {
  test("sorted, non-overlapping [start, end, rtl] triples", () => {
    expect(STRONG.length % 3).toBe(0);
    for (let i = 0; i < STRONG.length; i += 3) {
      expect(STRONG[i]!).toBeLessThanOrEqual(STRONG[i + 1]!);
      if (i) expect(STRONG[i]!).toBeGreaterThan(STRONG[i - 2]!);
    }
    expect(UNICODE_VERSION).toBe("17.0.0");
  });

  test("strong classes of the characters that decide a direction", () => {
    expect(classOf(0x41)).toBe("L"); // A
    expect(classOf(0x5d0)).toBe("R"); // א
    expect(classOf(0x627)).toBe("R"); // ا (AL)
    expect(classOf(0x640)).toBe("R"); // tatweel: AL, though its Script is Common
    expect(classOf(0x200f)).toBe("R"); // RIGHT-TO-LEFT MARK
    expect(classOf(0x200e)).toBe("L"); // LEFT-TO-RIGHT MARK
    expect(classOf(0x4e2d)).toBe("L"); // 中
    expect(classOf(0x5ff)).toBe("R"); // unassigned in the Hebrew block: the UCD default
    expect(classOf(0x30)).toBeUndefined(); // 0: European number, weak
    expect(classOf(0x660)).toBeUndefined(); // ٠: Arabic number, weak
    expect(classOf(0x20)).toBeUndefined(); // space
  });
});
