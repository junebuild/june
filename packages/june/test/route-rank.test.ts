// The shared precedence ranking (#312): the dev matcher orders a directory's
// children with compareSegments, the built worker orders its route table with
// compareRoutePatterns. route-precedence.test.ts proves the two resolvers agree
// end to end; this pins the ranking itself.
import { describe, expect, test } from "bun:test";

import { compareRoutePatterns, compareSegments, segmentRank } from "../src/route-rank";

describe("route-rank", () => {
  test("segment ranks: static < [param] < [[param]] < [...rest] < [[...rest]]", () => {
    expect(["feed.xml", "[slug]", "[[slug]]", "[...rest]", "[[...rest]]"].map(segmentRank)).toEqual([0, 1, 2, 3, 4]);
    // Not a param: a bracket that isn't a whole segment stays static.
    expect(segmentRank("[slug].png")).toBe(0);
    expect(segmentRank("[foo-bar]")).toBe(0);
  });

  test("siblings sort by rank, then by name", () => {
    const dirs = ["[[...all]]", "[slug]", "[[opt]]", "about", "[...rest]", "[id]"];
    expect(dirs.sort(compareSegments)).toEqual(["about", "[id]", "[slug]", "[[opt]]", "[...rest]", "[[...all]]"]);
  });

  test("patterns sort by the first differing segment; a shorter pattern that ends first wins", () => {
    const patterns = [
      "/[[...slug]]",
      "/[slug]",
      "/feed.xml",
      "/docs/[[...path]]",
      "/docs",
      "/x/[a]/c",
      "/api/[...all]",
      "/api/[id]",
      "/",
    ];
    expect(patterns.sort(compareRoutePatterns)).toEqual([
      "/",
      "/api/[id]",
      "/api/[...all]",
      "/docs",
      "/docs/[[...path]]",
      "/feed.xml",
      "/x/[a]/c",
      "/[slug]",
      "/[[...slug]]",
    ]);
    expect(compareRoutePatterns("/a/[b]", "/a/[b]")).toBe(0);
  });
});
