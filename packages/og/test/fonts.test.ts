// Google Fonts subsetting + cache utilities — shared by every OG backend, so
// this is load-bearing for all three. Network is mocked: the tests pin the
// subset-request shape (text= parameter, legacy-Safari UA for TTF), the css →
// font-URL extraction, the in-memory cache, and the failure mode.
//
// fonts.ts's memoryCache is a module-level Map that persists across every test
// in the process — so each test here uses a DISJOINT family name (or, for
// loadDefaultFonts, distinct text). Reusing a family/weight/text combo from
// another test would hit the cache and mask a fetch that should have happened.

import { afterEach, describe, expect, test } from "bun:test";

import { hasCJK, loadDefaultFonts, loadGoogleFont, OG_HEADERS } from "../src/fonts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchLog = { urls: string[] };

// Mock Google Fonts: the css2 endpoint returns a face whose src url encodes the
// requested family, and the font URL returns bytes derived from it — so a test
// can tell WHICH font a returned buffer came from.
const mockGoogleFonts = (): FetchLog => {
  const log: FetchLog = { urls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    log.urls.push(url);
    if (url.startsWith("https://fonts.googleapis.com/css2")) {
      // satori needs TTF/OTF — the loader forces it with a legacy Safari UA.
      expect(new Headers(init?.headers).get("User-Agent")).toContain("Safari/533");
      const family = new URL(url).searchParams.get("family") ?? "unknown";
      const slug = family.split(":")[0]!.replaceAll(" ", "-");
      return new Response(`@font-face { src: url(https://fonts.gstatic.com/${slug}.ttf); }`);
    }
    if (url.startsWith("https://fonts.gstatic.com/")) {
      return new Response(new TextEncoder().encode(url.split("/").pop()!));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return log;
};

describe("loadGoogleFont", () => {
  test("subsets by text and extracts the font URL from the css", async () => {
    const log = mockGoogleFonts();
    const buf = await loadGoogleFont("Test Subset", 600, "Hello");
    expect(new TextDecoder().decode(buf)).toBe("Test-Subset.ttf");
    const cssUrl = new URL(log.urls[0]!);
    expect(cssUrl.searchParams.get("family")).toBe("Test Subset:wght@600");
    expect(cssUrl.searchParams.get("text")).toBe("Hello");
  });

  test("memory cache: the same family/weight/text never refetches", async () => {
    const log = mockGoogleFonts();
    await loadGoogleFont("Test Cache", 600, "same");
    await loadGoogleFont("Test Cache", 600, "same");
    expect(log.urls.filter((u) => u.includes("css2")).length).toBe(1);
  });

  test("a different text is a different subset — it fetches again", async () => {
    const log = mockGoogleFonts();
    await loadGoogleFont("Test Cache Miss", 600, "one");
    await loadGoogleFont("Test Cache Miss", 600, "two");
    expect(log.urls.filter((u) => u.includes("css2")).length).toBe(2);
  });

  test("css without a src url fails loudly, naming the family", async () => {
    globalThis.fetch = (async () => new Response("/* no faces */")) as unknown as typeof fetch;
    await expect(loadGoogleFont("Test Broken", 600, "x")).rejects.toThrow(
      'could not extract font URL for "Test Broken"',
    );
  });
});

describe("loadDefaultFonts", () => {
  test("latin text loads Inter only", async () => {
    mockGoogleFonts();
    const fonts = await loadDefaultFonts("Plain latin title");
    expect(fonts.map((f) => f.name)).toEqual(["Inter"]);
    expect(fonts[0]).toMatchObject({ weight: 600, style: "normal" });
  });

  test("CJK text adds Noto Sans TC", async () => {
    mockGoogleFonts();
    const fonts = await loadDefaultFonts("中文標題");
    expect(fonts.map((f) => f.name)).toEqual(["Inter", "Noto Sans TC"]);
  });
});

describe("hasCJK", () => {
  test("detects Chinese and Japanese, not latin", () => {
    expect(hasCJK("hello world")).toBe(false);
    expect(hasCJK("純中文")).toBe(true);
    expect(hasCJK("タイトル")).toBe(true);
    expect(hasCJK("mixed 標題")).toBe(true);
  });
});

describe("OG_HEADERS", () => {
  test("matches the ImageResponse envelope defaults", () => {
    expect(OG_HEADERS["content-type"]).toBe("image/png");
    expect(OG_HEADERS["cache-control"]).toBe("public, max-age=86400, stale-while-revalidate=604800");
  });
});
