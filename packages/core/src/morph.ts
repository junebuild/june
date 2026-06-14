// The Route A applier — morph a live [data-june-root] toward a freshly-rendered
// fragment IN PLACE, so unchanged nodes keep their identity (focus, scroll,
// selection, form input, CSS transitions all survive) instead of being torn down
// and rebuilt by a wholesale replace.
//
// Islands are OPAQUE. react.dev forbids outside code from mutating React-owned
// DOM, so the morph NEVER recurses into a <june-island> interior. A persistent,
// already-live island is REUSED (its React root — state, effects, open
// connections — survives), relocated with moveBefore() where supported (a
// state-preserving reparent; the same primitive React core is adopting) and
// insertBefore otherwise. Any other island is taken fresh from the new tree and
// the caller re-hydrates it (hydrate is idempotent — it skips already-live nodes).
//
// v1 reconciles children positionally (the SSR skeleton aligns), with persistent
// islands matched by name so they survive even if their slot shifts. Pure +
// browser-only (touches the DOM); exposed via the @junejs/core/morph subpath.
import { ISLAND_TAG, ISLAND_NAME_ATTR, ISLAND_PERSIST_ATTR } from "./islands";

type Live = Element & { __juneHydrated?: boolean };

const isIsland = (n: Node): n is Element =>
  n.nodeType === 1 && (n as Element).tagName.toLowerCase() === ISLAND_TAG;
const islandName = (el: Element): string => el.getAttribute(ISLAND_NAME_ATTR) ?? "";
const isLivePersist = (n: Node): n is Live =>
  isIsland(n) && (n as Element).hasAttribute(ISLAND_PERSIST_ATTR) && !!(n as Live).__juneHydrated;

// Place `node` before `ref` in `parent`. For a node ALREADY in the document use
// moveBefore() when available (Chrome 133+) so its live state survives the
// reparent; a fresh (disconnected) node, or a browser without moveBefore, falls
// back to insertBefore.
function placeBefore(parent: Node, node: Node, ref: Node | null): void {
  const mb = (parent as { moveBefore?: (n: Node, r: Node | null) => void }).moveBefore;
  if (typeof mb === "function" && (node as ChildNode).isConnected && node.parentNode === parent) {
    try {
      mb.call(parent, node, ref);
      return;
    } catch {
      /* not movable in this position — fall through */
    }
  }
  parent.insertBefore(node, ref);
}

function syncAttrs(oldEl: Element, newEl: Element): void {
  for (const a of Array.from(oldEl.attributes)) {
    if (!newEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name);
  }
  for (const a of Array.from(newEl.attributes)) {
    if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value);
  }
}

const sameType = (a: Node, b: Node): boolean =>
  a.nodeType === b.nodeType &&
  (a.nodeType !== 1 || (a as Element).tagName === (b as Element).tagName);

const fresh = (parent: Node, n: Node): Node => parent.ownerDocument!.importNode(n, true);

// Morph oldEl's subtree to match newEl, in place.
export function morph(oldEl: Element, newEl: Element): void {
  syncAttrs(oldEl, newEl);

  // Persistent live islands, by name — so one survives even if its slot moved.
  const persist = new Map<string, Live>();
  for (const c of Array.from(oldEl.children)) if (isLivePersist(c)) persist.set(islandName(c), c);

  let o = oldEl.firstChild;
  for (let n = newEl.firstChild; n; n = n.nextSibling) {
    if (isIsland(n)) {
      const live = persist.get(islandName(n as Element));
      const node = live ?? fresh(oldEl, n); // reuse the live island, else a fresh marker
      if (node !== o) placeBefore(oldEl, node, o); // moveBefore live / insert fresh before cursor
      else o = o.nextSibling; // already exactly here
      if (live) persist.delete(islandName(n as Element));
      continue;
    }
    // Static node: align the cursor past any old island sitting here (its fate is
    // decided by its own new-side entry, or the trailing cleanup).
    while (o && isIsland(o)) o = o.nextSibling;
    if (o && sameType(o, n) && !isIsland(o)) {
      if (n.nodeType === 1) morph(o as Element, n as Element); // recurse static
      else if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
      o = o.nextSibling;
    } else {
      placeBefore(oldEl, fresh(oldEl, n), o); // insert a fresh copy before the cursor
    }
  }

  // Remove whatever old nodes are left after the cursor — EXCEPT live persistent
  // islands we reused above (already moved into place; they're no longer in the
  // `persist` map and won't be here, but guard anyway).
  while (o) {
    const next = o.nextSibling;
    if (!isLivePersist(o) || persist.has(islandName(o as Element))) oldEl.removeChild(o);
    o = next;
  }
}
