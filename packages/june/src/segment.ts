// Segment-boundary resolution — the ONE place the "deepest segmentBoundary wins"
// rule lives, shared by the dev resolver (app.ts), the build manifest, and the
// codegen (build.ts). Single-sourcing it keeps dev / frozen-manifest / deployed
// worker from drifting on the exact invariant the feature depends on.
//
// HOST-ONLY (uses node:crypto): runs in the dev server and at build time, never
// in the worker request path — the worker reads the frozen key from the manifest.
import { createHash } from "node:crypto";

export const boundaryWarning = (file: string): string =>
  `[june] multiple segmentBoundary layouts in one chain (${file}); using the deepest.`;

// A stable key identifying a boundary layout (its persistent shell). Same file →
// same key (a shell shared across routes); different file → different key (a
// distinct shell), so the client can tell whether a soft-nav fragment belongs to
// the shell currently mounted and hard-navigate when it doesn't. Consistency is
// only needed WITHIN one running instance (dev server OR deployed worker), since
// the key is compared between an outlet's host marker and a response header both
// produced by that same instance — dev and prod need not agree.
//
// Memoized: the dev resolver runs per request, and the key is a pure function of
// the path. 16 hex chars (64 bits) makes a same-instance collision between two
// boundary layouts — which would morph one shell's content into another — beyond
// reach without inflating the wire marker.
const keyCache = new Map<string, string>();
export function boundaryKey(file: string): string {
  let key = keyCache.get(file);
  if (key === undefined) {
    key = createHash("sha256").update(file).digest("hex").slice(0, 16);
    keyCache.set(file, key);
  }
  return key;
}

// Build the layout chain (root→leaf, null entries filtered) and locate the
// boundary: the DEEPEST entry flagged `boundary`. The index is into the FILTERED
// chain — every consumer filters identically, so the index always matches the
// chain the worker actually renders. Generic over the entry type so codegen can
// pass layout-id strings where dev/build pass component functions.
export function resolveBoundary<C>(
  items: Array<{ file: string; entry: C | null; boundary: boolean }>,
): { chain: C[]; boundaryIndex: number | null; key: string | null } {
  const chain: C[] = [];
  let boundaryIndex: number | null = null;
  let boundaryFile: string | null = null;
  for (const it of items) {
    if (it.entry == null) continue; // dropped layout — filtered consistently everywhere
    if (it.boundary) {
      if (boundaryIndex !== null) console.warn(boundaryWarning(it.file));
      boundaryIndex = chain.length;
      boundaryFile = it.file;
    }
    chain.push(it.entry);
  }
  return {
    chain,
    boundaryIndex,
    key: boundaryFile === null ? null : boundaryKey(boundaryFile),
  };
}
