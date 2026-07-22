// The live-update applier (Route A). A transport — an SSE/WebSocket channel, or
// the dev server's push-HMR — re-renders the CURRENT page's `fragment` on the
// server and hands the HTML here; we MORPH it into [data-june-root] in place,
// preserving EVERY live island's React state (the same page is re-rendering, so
// nothing should reset — only the static skeleton around the islands changes).
//
// This is the apply half; it is transport-agnostic on purpose. Unlike a soft
// navigation it does NOT touch history or scroll — it's the same URL, updated.
//
// Browser-only (touches the DOM); exposed via the @junejs/core/client-live subpath.
import { executeScripts, neutralizeScripts } from "./execute-scripts";
import { morph } from "./morph";
import { SHELL_ATTR } from "./nav-protocol";
import { resolveSwapTarget } from "./shell";

export type Rehydrate = (root: ParentNode) => void;

// Apply a server-pushed re-render of the current page. Returns false (so the
// caller can fall back) when there's no live region to update.
//
// `segmentShell` is the fragment's shell key (the SEGMENT_HEADER from the
// re-render). When set — the current page is a segment-boundary route, so the
// pushed fragment is content-only — we morph into [data-june-outlet], NOT
// [data-june-root]; morphing content-only HTML into the root would delete the
// persistent shell. (It is the same page, so the key matches the mounted shell.)
export function applyLiveUpdate(
  fragmentHtml: string,
  title: string | null,
  rehydrate: Rehydrate,
  segmentShell?: string | null,
): boolean {
  // Same shell-identity resolution as a soft navigation (the SAME page is
  // re-rendering, so a segment fragment's key matches the mounted shell → its
  // outlet; a non-boundary re-render → the root).
  const fragmentShell = segmentShell ?? null;
  const current = resolveSwapTarget(fragmentShell);
  if (!current) return false;
  // Parse the fragment into an inert clone of the target, then morph in place with
  // ALL islands preserved (live-update semantics).
  const next = current.cloneNode(false) as Element;
  next.innerHTML = fragmentHtml;
  // Stamp the fragment's scripts pending so nothing runs mid-morph; activated below.
  neutralizeScripts(next);
  if (fragmentShell === null) next.removeAttribute(SHELL_ATTR); // keep the root shell key honest
  morph(current, next, { preserveIslands: "all" });
  // Title before scripts (reload parity — a script reading document.title must
  // see the pushed value), then activate the re-rendered region's scripts so its
  // behaviors come back (dev HMR relies on this; region scripts must be
  // repeat-safe in the same realm — see the execute-scripts contract).
  if (title !== null) document.title = title;
  executeScripts(current);
  rehydrate(current); // hydrate any NEW island markers (idempotent — skips live ones)
  return true;
}
