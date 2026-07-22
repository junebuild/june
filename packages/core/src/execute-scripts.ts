// The swap-time script activator — hard-navigation parity for morphed regions.
//
// A fragment arrives as HTML and is parsed via `innerHTML`; per the HTML spec,
// scripts created by the fragment parser never execute. So after a soft
// navigation (or a live-update / dev-HMR re-render) the new page's per-region
// scripts — tab wiring, copy buttons, diagram renderers — would silently be
// dead. This pair restores the hard-load contract: after a swap, every
// executable script in the swapped region runs exactly once.
//
// It is a PAIR by design — both appliers call both halves:
//   neutralizeScripts(next)   BEFORE morph: stamp every executable script in the
//                             parsed fragment with a pending type, so nothing
//                             can run during the morph itself.
//   executeScripts(target)    AFTER morph: rebuild each pending script as a
//                             fresh element (the only spec-sanctioned way to
//                             make one runnable — the Turbo/htmx approach),
//                             restoring its original type.
//
// Why neutralize at all, when the spec already keeps fragment scripts inert?
// Because that inertness rides the "already started" flag through importNode /
// cloneNode — a subtle journey not every DOM implementation reproduces
// (happy-dom executes imported scripts, for one), and one the morph layer
// shouldn't have to trust. Stamping a non-executable type makes the invariant
// explicit: a fragment script CANNOT run before activation, anywhere, and the
// activation count is exactly the fragment's executable-script count.
//
// The pending stamp also solves morph's node-keeping subtlety for free: an
// unchanged script element survives the swap already-run, but the DOM it bound
// listeners to was just replaced. Attribute sync marks the survivor pending, so
// it re-runs like everything else. The region-script contract is therefore
// "idempotent or delegated" — the same bar any script must clear to survive a
// browser reload.
//
// Out of scope by design:
//  - Island interiors — React-owned DOM is opaque to the swap layer (the morph
//    contract); islands re-run their own effects via re-hydration.
//  - Non-executable types (JSON-LD and other data blocks) — nothing to run.
//  - `data-june-once` scripts — full-page-load only (analytics bootstrapping
//    and the like): neutralized like the rest, then restored in place without
//    a rebuild, so a swap never runs them.
//
// Known limit: a `<script type="module" src>` re-executes only once per
// document (the module map caches by URL) — inline modules re-run fine.
//
// PURE per the contract layer's rule (no `node:*` / `Bun.*`); browser-only
// (touches `document`), consumed by client-router and client-live — not
// exported from the barrel.
import { ISLAND_TAG } from "./islands";

// Executable script types — the HTML spec's full classic JavaScript MIME
// essence list, plus the absent type and "module"; anything else is a data
// block. A hard load executes ALL of these, so the swap layer must too.
const EXECUTABLE = new Set([
  "",
  "module",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// Match by MIME essence, the way the browser does: parameters stripped
// (`text/javascript;charset=utf-8` is executable), whitespace trimmed.
const isExecutable = (type: string): boolean =>
  EXECUTABLE.has((type.split(";")[0] ?? "").trim().toLowerCase());

// The pending stamp and the stash for the script's real type ("" stays absent).
const PENDING_TYPE = "text/x-june-pending";
const ORIG_TYPE_ATTR = "data-june-type";

// Opt-out: this script runs on a full document load only, never on a swap.
export const RUN_ONCE_ATTR = "data-june-once";

// BEFORE morph: stamp every executable script in the parsed fragment so it
// cannot run while morph inserts it (regardless of DOM-implementation quirks).
export function neutralizeScripts(region: Element): void {
  for (const s of Array.from(region.querySelectorAll("script"))) {
    if (s.closest(ISLAND_TAG)) continue; // islands are opaque — React owns that DOM
    if (!isExecutable(s.type)) continue; // data block — leave it alone
    const orig = s.getAttribute("type");
    if (orig) s.setAttribute(ORIG_TYPE_ATTR, orig);
    s.setAttribute("type", PENDING_TYPE);
  }
}

// AFTER morph: activate every pending script in the swapped region. Inline
// scripts execute synchronously at their replace, preserving document order;
// external ones get `async = false` so the browser queues them in order.
export function executeScripts(region: Element): void {
  for (const old of Array.from(
    region.querySelectorAll<HTMLScriptElement>(`script[type="${PENDING_TYPE}"]`),
  )) {
    if (old.closest(ISLAND_TAG)) continue;
    const origType = old.getAttribute(ORIG_TYPE_ATTR);
    if (old.hasAttribute(RUN_ONCE_ATTR)) {
      // Restore the stamp in place — same node, so it stays un-run.
      if (origType) old.setAttribute("type", origType);
      else old.removeAttribute("type");
      old.removeAttribute(ORIG_TYPE_ATTR);
      continue;
    }
    const fresh = document.createElement("script");
    for (const a of Array.from(old.attributes)) fresh.setAttribute(a.name, a.value);
    if (origType) fresh.setAttribute("type", origType);
    else fresh.removeAttribute("type");
    fresh.removeAttribute(ORIG_TYPE_ATTR);
    // CSP3 hides `nonce` from getAttribute — carry it via the property.
    if (old.nonce) fresh.nonce = old.nonce;
    fresh.textContent = old.textContent;
    if (old.src) fresh.async = false;
    old.replaceWith(fresh); // an inline script executes synchronously here
  }
}
