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
// it re-runs like everything else.
//
// THE REGION-SCRIPT CONTRACT — repeat-safe in the SAME realm, which is
// STRICTER than surviving a reload: a reload gets a fresh JavaScript realm and
// a fresh DOM, activation gets neither. Re-runs share the realm's global
// lexical environment (a bare top-level `const`/`let` throws "already
// declared" on the second activation — wrap the script in an IIFE, or use
// `var`/function declarations), and morph PRESERVES unchanged elements (a
// direct addEventListener on a preserved node accumulates — delegate, guard,
// or bind only to elements the fragment actually replaced).
//
// Never activated (but still neutralized, so they can't run mid-swap either):
//  - Island interiors — React-owned DOM the swap layer must not run scripts
//    in; islands re-run their own effects via re-hydration. Their scripts are
//    stamped like the rest (a FRESH island's subtree is imported and connected
//    by the morph — in a drift DOM that's an execution vector) and restored in
//    place right after the morph, before re-hydration sees the subtree.
//  - `data-june-once` scripts — full-page-load only (analytics bootstrapping
//    and the like): restored in place without a rebuild, so a swap never runs
//    them.
// Not touched at all:
//  - Non-executable types (JSON-LD and other data blocks) — nothing to run.
//
// Known limits:
//  - A `<script type="module" src>` re-executes only once per document (the
//    module map caches by URL) — inline modules re-run fine.
//  - Activation does not await the network: inline CLASSIC scripts run
//    synchronously in document order, and external non-async scripts load in
//    order relative to EACH OTHER (`async = false`), but a later inline script
//    will not wait for a preceding external one the way a parsing hard load
//    would. That trade — shared with Turbo and htmx — keeps activation
//    synchronous, so a slow CDN can never stall island re-hydration or a rapid
//    follow-up navigation. An inline script depending on an external sibling
//    should listen for its load event (or the pair belongs in one script).
//  - Module evaluation is queued, not synchronous: per the module algorithm,
//    even an INLINE `type="module"` script evaluates after activation returns
//    — so island re-hydration (and any later classic script) can run before
//    it. Module-based page setup that must observe the pre-hydration DOM
//    belongs in a classic script (or in the island itself).
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

// The pending stamp: a non-executable type (the inertness guarantee) PLUS a
// marker attribute (the identity guarantee — authored markup could carry the
// sentinel type, and activation must never promote a script it didn't stamp).
// ORIG_TYPE_ATTR stashes the script's real type ("" stays absent).
const PENDING_TYPE = "text/x-june-pending";
const PENDING_ATTR = "data-june-pending";
const ORIG_TYPE_ATTR = "data-june-type";

// Opt-out: this script runs on a full document load only, never on a swap.
export const RUN_ONCE_ATTR = "data-june-once";

// BEFORE morph: stamp every executable script in the parsed fragment so it
// cannot run while morph inserts it (regardless of DOM-implementation quirks).
// Island interiors are stamped too — the morph deep-imports and connects a
// FRESH island's subtree, which in a drift DOM would otherwise execute its
// scripts mid-swap; activation restores them un-run before re-hydration.
export function neutralizeScripts(region: Element): void {
  for (const s of Array.from(region.querySelectorAll("script"))) {
    if (!isExecutable(s.type)) continue; // data block — leave it alone
    const orig = s.getAttribute("type");
    if (orig) s.setAttribute(ORIG_TYPE_ATTR, orig);
    s.setAttribute("type", PENDING_TYPE);
    s.setAttribute(PENDING_ATTR, "");
  }
}

// AFTER morph: activate every pending script in the swapped region. Inline
// scripts execute synchronously at their replace, preserving document order;
// external ones not authored `async` get `async = false` so the browser queues
// them in order relative to each other (an authored `async` is respected —
// that script opted into unordered execution, exactly as on a hard load).
export function executeScripts(region: Element): void {
  for (const old of Array.from(
    // BOTH halves of the stamp: authored markup wearing the sentinel type (but
    // never stamped by neutralizeScripts) must not be promoted to executable.
    region.querySelectorAll<HTMLScriptElement>(`script[type="${PENDING_TYPE}"][${PENDING_ATTR}]`),
  )) {
    const origType = old.getAttribute(ORIG_TYPE_ATTR);
    // Island-interior and run-once scripts: restore the stamp in place — same
    // node, so they stay un-run (and the island subtree is back to its SSR
    // shape before re-hydration reads it).
    if (old.closest(ISLAND_TAG) || old.hasAttribute(RUN_ONCE_ATTR)) {
      if (origType) old.setAttribute("type", origType);
      else old.removeAttribute("type");
      old.removeAttribute(ORIG_TYPE_ATTR);
      old.removeAttribute(PENDING_ATTR);
      continue;
    }
    const fresh = document.createElement("script");
    for (const a of Array.from(old.attributes)) fresh.setAttribute(a.name, a.value);
    if (origType) fresh.setAttribute("type", origType);
    else fresh.removeAttribute("type");
    fresh.removeAttribute(ORIG_TYPE_ATTR);
    fresh.removeAttribute(PENDING_ATTR);
    // CSP3 hides `nonce` from getAttribute — carry it via the property.
    if (old.nonce) fresh.nonce = old.nonce;
    fresh.textContent = old.textContent;
    if (old.src && !old.hasAttribute("async")) fresh.async = false;
    // An inline CLASSIC script executes synchronously right here; an inline
    // MODULE queues its evaluation (see the module-timing limit above).
    old.replaceWith(fresh);
  }
}
