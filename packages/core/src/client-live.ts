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
import { morph } from "./morph";

const ROOT_ATTR = "data-june-root";

export type Rehydrate = (root: ParentNode) => void;

// Apply a server-pushed re-render of the current page. Returns false (so the
// caller can fall back) when there's no live region to update.
export function applyLiveUpdate(
  fragmentHtml: string,
  title: string | null,
  rehydrate: Rehydrate,
): boolean {
  const current = document.querySelector(`[${ROOT_ATTR}]`);
  if (!current) return false;
  // Parse the fragment into an inert clone of the root, then morph in place with
  // ALL islands preserved (live-update semantics).
  const next = current.cloneNode(false) as Element;
  next.innerHTML = fragmentHtml;
  morph(current, next, { preserveIslands: "all" });
  if (title !== null) document.title = title;
  rehydrate(current); // hydrate any NEW island markers (idempotent — skips live ones)
  return true;
}
