// The title codec — the SERVER encodeTitles before headers.set, the CLIENT
// decodeTitles before document.title. The two ends share these so the encoding
// can't drift; decode is defensive so a malformed header never forces a hard nav.
import { describe, expect, test } from "bun:test";

import { decodeTitle, encodeTitle } from "../src/nav-protocol";

describe("title codec", () => {
  test("ASCII titles are byte-identical on the wire (no needless encoding)", () => {
    expect(encodeTitle("Home")).toBe("Home");
    expect(decodeTitle("Home")).toBe("Home");
  });

  test("a non-ASCII title round-trips through encode → decode", () => {
    const title = "文件中心 — 整合指南 🚀";
    const wire = encodeTitle(title);
    expect(wire).toBe(encodeURIComponent(title)); // ASCII-safe header value
    expect(/^[\x00-\x7F]*$/.test(wire)).toBe(true); // every byte ≤ 0x7F → valid ByteString
    expect(decodeTitle(wire)).toBe(title);
  });

  test("decodeTitle is defensive: a malformed value falls back to raw, never throws", () => {
    // A literal `%` not followed by two hex digits would throw URIError in
    // decodeURIComponent — that must NOT bubble (it would force a hard nav).
    expect(() => decodeTitle("100% Coverage")).not.toThrow();
    expect(decodeTitle("100% Coverage")).toBe("100% Coverage");
    expect(decodeTitle("%")).toBe("%");
    expect(decodeTitle("%E0%A4%A")).toBe("%E0%A4%A"); // truncated sequence
  });

  test("decodeTitle passes null through (no header present)", () => {
    expect(decodeTitle(null)).toBeNull();
  });
});
