// Route precedence — the ONE ranking both resolvers use (#312). The dev matcher
// (router.ts, matchRouteTree) walks the app tree trying each level's children in
// this order; the built worker (worker.ts) cannot walk a tree, so it sorts its
// flat route table with compareRoutePatterns and takes the first regex match.
// For patterns that both match a URL, the depth-first walk and the sorted table
// pick the same winner: the first segment where two patterns differ decides.
//
// Worker-safe: no node:* imports.

export type SegmentKind = "static" | "param" | "optional" | "catchAll" | "optionalCatchAll";

// The one segment grammar: a param name is an identifier ([A-Za-z_][A-Za-z0-9_]*).
// Anything else in brackets (`[1]`, `[foo-bar]`, `[slug].png`) is a STATIC
// segment named literally, in dev, in the ranking and in the worker's regex.
const DYNAMIC = /^\[(\[)?(\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\](\])?$/;

export function parseSegment(segment: string): { kind: SegmentKind; name?: string } {
  const m = segment.match(DYNAMIC);
  // Brackets must pair: `[[x]]` or `[x]`, never `[[x]` / `[x]]`.
  if (!m || !!m[1] !== !!m[4]) return { kind: "static" };
  const optional = !!m[1];
  const catchAll = !!m[2];
  const kind: SegmentKind = catchAll
    ? optional ? "optionalCatchAll" : "catchAll"
    : optional ? "optional" : "param";
  return { kind, name: m[3] };
}

const RANK: Record<SegmentKind, number> = { static: 0, param: 1, optional: 2, catchAll: 3, optionalCatchAll: 4 };

// Per-segment rank, most specific first: static, [param], [[param]], [...rest],
// [[...rest]]. Optional sits after its required form, so `[slug]` answers
// before `[[slug]]` when a segment is present.
export function segmentRank(segment: string): number {
  return RANK[parseSegment(segment).kind];
}

// Sibling order within one directory level: by rank, then by name so a tie
// (two [param] dirs) resolves the same on every filesystem.
export function compareSegments(a: string, b: string): number {
  return segmentRank(a) - segmentRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// Order two file-route patterns ("/docs/[[...path]]", "/feed.xml") by
// precedence. The first differing segment decides; a pattern that ends there
// beats one that continues, since only absent optional segments can follow a
// match that already consumed the URL (dev checks a directory's own page before
// descending into its optional children).
export function compareRoutePatterns(a: string, b: string): number {
  const as = a.split("/").filter(Boolean);
  const bs = b.split("/").filter(Boolean);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return compareSegments(x, y);
  }
  return 0;
}
