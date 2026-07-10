// The pure static-file helpers: extension→MIME and the path-safety cleaner that
// guards every public/ lookup (dev host + Deno runtime) against traversal.
import { describe, expect, test } from "bun:test";

import { contentTypeFor, RESERVED_PREFIX, safeRelativePath } from "../src/static-files";

describe("contentTypeFor", () => {
  test("known extensions map to their MIME (case-insensitive)", () => {
    expect(contentTypeFor("/logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/a/b/photo.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("/x.png")).toBe("image/png");
    expect(contentTypeFor("/font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("/site.webmanifest")).toBe("application/manifest+json");
  });

  test("unknown or extensionless → octet-stream", () => {
    expect(contentTypeFor("/data.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/noext")).toBe("application/octet-stream");
  });
});

describe("safeRelativePath", () => {
  test("normal files resolve to a clean forward-slash relative path", () => {
    expect(safeRelativePath("/logo.svg")).toBe("logo.svg");
    expect(safeRelativePath("/images/hero.png")).toBe("images/hero.png");
    expect(safeRelativePath("/a/./b/c.txt")).toBe("a/b/c.txt"); // "." segments dropped
    expect(safeRelativePath("/with%20space.txt")).toBe("with space.txt"); // decoded
  });

  test("the framework prefix is NOT rejected here (Deno serves /_june/* too)", () => {
    // Reservation is enforced by the callers (dev lookup / build copy), not the
    // path cleaner — the Deno asset server must be able to serve real _june assets.
    expect(safeRelativePath("/_june/client.abcd1234.js")).toBe("_june/client.abcd1234.js");
    expect(RESERVED_PREFIX).toBe("_june");
  });

  test("traversal, backslashes, NUL, and the bare root are rejected", () => {
    expect(safeRelativePath("/../etc/passwd")).toBeNull();
    expect(safeRelativePath("/a/../../b")).toBeNull();
    expect(safeRelativePath("/%2e%2e/secret")).toBeNull(); // encoded ".."
    expect(safeRelativePath("/a%5c..%5cb")).toBeNull(); // encoded backslash
    expect(safeRelativePath("/a%00.png")).toBeNull(); // NUL byte
    expect(safeRelativePath("/")).toBeNull(); // a page, not a file
    expect(safeRelativePath("/%ZZ")).toBeNull(); // malformed %-encoding
  });
});
