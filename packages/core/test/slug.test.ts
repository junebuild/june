// @junejs/core/slug — heading ids with GitHub's rules, the one algorithm the content
// pipeline and any downstream indexer share. The expectations are the anchors GitHub
// itself renders for these headings.
import { describe, expect, test } from "bun:test";

import { createSlugger, slugify } from "@junejs/core/slug";

describe("slugify (GitHub's rules)", () => {
  test.each([
    ["Hello World", "hello-world"],
    ["Getting started", "getting-started"],
    // punctuation and symbols drop; each space is its own "-" (not collapsed)
    ["Auth: tokens never reach the model", "auth-tokens-never-reach-the-model"],
    ["A & B", "a--b"],
    ["C++ and C#", "c-and-c"],
    ["What's new?", "whats-new"],
    ["`ctx.user` and ctx.store.unwrap()", "ctxuser-and-ctxstoreunwrap"],
    // `_` (connector punctuation) and `-` survive
    ["snake_case and kebab-case", "snake_case-and-kebab-case"],
    // other dashes are punctuation
    ["Setup — then run", "setup--then-run"],
    // emoji drop
    ["Ship it 🚀 today", "ship-it--today"],
    // every script's letters and marks stay
    ["Über café", "über-café"],
    ["邊緣排版與字型子集化", "邊緣排版與字型子集化"],
    ["OG 圖卡 (CJK) と 한국어", "og-圖卡-cjk-と-한국어"],
    ["Привет мир", "привет-мир"],
    ["Version 2.0", "version-20"],
  ])("%p → %p", (text, slug) => expect(slugify(text)).toBe(slug));

  test('a heading that slugs to nothing gets "section", never id=""', () => {
    expect(slugify("?!")).toBe("section");
    expect(slugify("🎉")).toBe("section");
    expect(slugify("")).toBe("section");
  });
});

describe("createSlugger (one per document)", () => {
  test("repeats get -1, -2 in document order", () => {
    const slug = createSlugger();
    expect(["Setup", "Usage", "Setup", "Setup"].map(slug)).toEqual(["setup", "usage", "setup-1", "setup-2"]);
  });

  test('a suffixed id is re-checked: "Setup", "Setup", "Setup 1" never collide', () => {
    const slug = createSlugger();
    expect(["Setup", "Setup", "Setup 1"].map(slug)).toEqual(["setup", "setup-1", "setup-1-1"]);
  });

  test("repeats of the fallback are numbered too", () => {
    const slug = createSlugger();
    expect(["?!", "…"].map(slug)).toEqual(["section", "section-1"]);
  });

  test("each slugger is independent — a new document starts fresh", () => {
    const a = createSlugger();
    a("Setup");
    expect(createSlugger()("Setup")).toBe("setup");
  });
});
