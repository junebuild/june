// The opt-in client router — June's progressive-enhancement SPA layer.
//
// OFF by default (config.clientRouter). When on, the document wraps the page in
// <div data-june-root> and the islands bundle calls startClientRouter() once.
// From then on, same-origin left-clicks become SOFT navigations: fetch the next
// URL's `fragment` projection (the [data-june-root] inner HTML for the SAME url —
// HTML-over-the-wire, the agent surface untouched), then MORPH it into the live
// region — unchanged nodes keep focus/scroll/selection/input, and a persistent
// island's live React root survives. New islands re-hydrate.
//
// It degrades safely: no JS, a failed fetch, or an unrecognized response shape
// all fall back to a hard browser navigation — never a broken page.
//
// PURE per the contract layer's rule (no `node:*` / `Bun.*`); it is browser-only
// (touches `document`/`history`/`fetch`), so — like islands-client — it is
// exposed ONLY via the `@junejs/core/client-router` subpath and is NOT
// re-exported from the barrel.
import { executeScripts, neutralizeScripts } from "./execute-scripts";
import { morph } from "./morph";
import { FRAGMENT_ACCEPT, SEGMENT_HEADER, SHELL_ATTR, TITLE_HEADER, decodeTitle } from "./nav-protocol";
import { outletEl, resolveSwapTarget } from "./shell";

// Called with each freshly swapped-in region so the host can hydrate the new
// page's islands (islands-client binds this to its registry). In whole-chain
// mode this is [data-june-root]; in segment mode it is the [data-june-outlet].
export type Rehydrate = (root: ParentNode) => void;

// Strip a single trailing slash (except the root "/") so an exact-page link and
// the current path compare equal regardless of slash form — June doesn't redirect
// "/guide/" to "/guide", so both reach the client verbatim.
const trimSlash = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

// The shell links (a[href] OUTSIDE the outlet) reconciled on each nav, cached
// while the SAME outlet is mounted. In segment mode morph never touches the shell
// and the outlet element keeps its identity across same-shell soft-navs, so the
// list is stable; a new shell (or a fresh document) yields a different outlet
// element and rebuilds. This turns a per-nav `querySelectorAll` + per-link
// `contains()` (O(all links) on a 1000-link sidebar) into a one-time scan reused
// across navigations. (A shell island that mutates its own nav links at runtime
// won't be re-scanned until the shell remounts — docs sidebars are static.)
let cachedOutlet: Element | null = null;
let cachedShellLinks: HTMLAnchorElement[] = [];

// Segment-scoped mode moves the shell (sidebar/nav, with its active-link state)
// OUTSIDE the swapped region, so morph no longer re-renders aria-current. This
// reconciles it from location.pathname — the trade the granularity optimization
// makes. No-op in whole-chain mode (no outlet), where morph already re-renders
// the shell. A shell link is active when it points at the current page OR an
// ancestor of it (section highlight), matching the common SSR convention.
function updateActiveLinks(): void {
  const outlet = outletEl();
  if (!outlet) return; // whole-chain mode — morph carries aria-current for free
  if (cachedOutlet !== outlet) {
    cachedOutlet = outlet;
    cachedShellLinks = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).filter((a) => !outlet.contains(a) && a.origin === location.origin);
  }
  const here = trimSlash(location.pathname);
  for (const a of cachedShellLinks) {
    const p = trimSlash(a.pathname);
    const exact = p === here;
    const active = exact || (p !== "/" && here.startsWith(p + "/"));
    if (active) a.setAttribute("aria-current", exact ? "page" : "true");
    else if (a.hasAttribute("aria-current")) a.removeAttribute("aria-current");
  }
}

// Agent surfaces + non-HTML stay hard navigations — the same exclusions the
// speculation rules use (humans soft-navigate; a link to llms.txt must not).
function isHardNav(url: URL): boolean {
  return /\.(md|json|txt|xml)$/.test(url.pathname) || url.pathname === "/mcp";
}

// The part of the URL a soft-nav is keyed on: path + query, never the hash. Two
// URLs with the same key are the same document; only the browser's own fragment
// scrolling differs between them.
const pageKey = (): string => location.pathname + location.search;

const isHex = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

// The URL spec's percent-decode followed by a non-fatal UTF-8 decode — what a
// hard load does to a fragment before looking it up. Byte-level: each
// well-formed `%XX` becomes one byte, anything else passes through unchanged,
// and an invalid UTF-8 sequence decodes to U+FFFD rather than failing. Both are
// where decodeURIComponent differs: it is all-or-nothing on a malformed escape
// AND on invalid UTF-8, so `%41%C0` would throw instead of yielding "A�".
function percentDecode(s: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  const src = new TextEncoder().encode(s);
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b === 0x25 /* % */ && i + 2 < src.length && isHex(src[i + 1]!) && isHex(src[i + 2]!)) {
      out.push(parseInt(String.fromCharCode(src[i + 1]!, src[i + 2]!), 16));
      i += 2;
    } else {
      out.push(b);
    }
  }
  // "UTF-8 decode without BOM": a leading U+FEFF is part of the id, not a
  // byte-order mark to strip (TextDecoder strips it unless told otherwise).
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(out));
}

// The HTML spec's "find a potential indicated element", as a hard load does it:
// the RAW fragment first, then its percent-decoded form; each tried as an id,
// then as the name of an <a> (only anchors — a same-named <input> or <form>
// does not count). Null when nothing matches.
function indicatedElement(fragment: string): Element | null {
  const decoded = percentDecode(fragment);
  const candidates = decoded === fragment ? [fragment] : [fragment, decoded];
  for (const id of candidates) {
    const byId = document.getElementById(id);
    if (byId) return byId;
    for (const el of Array.from(document.getElementsByName(id))) {
      if (el.localName === "a") return el;
    }
  }
  return null;
}

// Where a freshly swapped-in page lands: the element its `#fragment` indicates,
// else the top. Runs AFTER morph so the new content is what gets measured.
function landOn(hash: string): void {
  const el = hash.length > 1 ? indicatedElement(hash.slice(1)) : null;
  if (el) el.scrollIntoView?.();
  else window.scrollTo?.(0, 0);
}

export function startClientRouter(rehydrate: Rehydrate): void {
  // Idempotent: the bundle may call this on every full-document hydrate, but the
  // listeners must be attached exactly once.
  const w = window as unknown as { __juneRouter?: boolean };
  if (w.__juneRouter) return;
  w.__juneRouter = true;

  // Navigation generation token. Every navigation bumps it; any fetch that
  // resolves AFTER a newer navigation started is stale and dropped. This is the
  // fix for the click-then-back / rapid-nav race the /tmp spike surfaced (where
  // a slow response clobbered a newer page). The in-flight request is also
  // aborted so the superseded fetch doesn't even finish.
  let token = 0;
  let inflight: AbortController | null = null;

  // The page (path + query) the document currently shows. popstate compares
  // against it to tell a real history traversal from a fragment change: the
  // browser fires popstate for `#hash` navigations too (a ToC click, a pasted
  // same-page deep link, back/forward between two anchors), and those must NOT
  // re-fetch and re-land the page — the browser already scrolled to the anchor,
  // and a soft-nav on top of it would drag the reader back to the top.
  let lastPage = pageKey();

  async function navigate(href: string, push: boolean): Promise<void> {
    const mine = ++token;
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;

    let html: string;
    let title: string | null = null;
    let fragmentShell: string | null = null; // SEGMENT_HEADER: the fragment's shell key (null = whole-chain)
    try {
      const res = await fetch(href, {
        headers: { accept: FRAGMENT_ACCEPT },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      // The click guard checked the REQUESTED origin, but fetch follows
      // redirects — a same-origin endpoint can land on CORS-readable
      // cross-origin HTML whose scripts would then run under THIS document's
      // origin (a hard nav runs them under the destination's). Revalidate the
      // FINAL url and hand any cross-origin landing back to the browser.
      // (res.url is "" in some non-browser Response stubs — nothing to check.)
      if (res.url && new URL(res.url).origin !== location.origin) {
        if (mine === token) location.href = href;
        return;
      }
      // A SAME-origin redirect must land history on the FINAL url (hard-nav
      // parity): relative assets in activated scripts resolve against
      // location, so /docs redirected to /docs/ must not leave /docs in the
      // bar (src="page.js" would resolve to /page.js instead of
      // /docs/page.js). The requested hash survives — redirects drop it.
      if (res.url) {
        const final = new URL(res.url);
        href = final.pathname + final.search + (final.hash || new URL(href, location.origin).hash);
      }
      html = await res.text();
      // The server encodeTitles the header; decode it back before document.title.
      title = decodeTitle(res.headers.get(TITLE_HEADER));
      fragmentShell = res.headers.get(SEGMENT_HEADER);
    } catch (err) {
      // Aborted or superseded: a newer navigation owns the screen now — do
      // nothing. Otherwise the network/server actually failed: hand back to the
      // browser so the user still gets the page (or its real error).
      if ((err as { name?: string })?.name === "AbortError" || mine !== token) return;
      location.href = href;
      return;
    }
    if (mine !== token) return; // a newer navigation won the race — drop this result

    // Resolve the morph target by shell identity: a segment fragment (header =
    // its shell key) morphs the [data-june-outlet] ONLY when that key matches the
    // mounted shell; a cross-shell key, a missing <JuneOutlet>, or a stale shell
    // resolves to null → hard-navigate so the right shell loads instead of
    // corrupting this one. A whole-chain fragment (no header) morphs the root.
    const current = resolveSwapTarget(fragmentShell);
    if (!current) {
      location.href = href;
      return;
    }
    // The fragment is the target's INNER html. Parse it into an inert clone of
    // the target, then morph the live target toward it in place.
    const next = current.cloneNode(false) as Element;
    next.innerHTML = html;
    // The fragment's scripts were parsed inert; stamp them pending so nothing can
    // run mid-morph, then executeScripts activates them after the swap.
    neutralizeScripts(next);
    // Whole-chain morph into the root: the root is no longer a boundary shell, so
    // drop any stale shell key the clone copied — else mountedShellKey() would lie
    // on the next navigation and could mis-target a later segment fragment.
    if (fragmentShell === null) next.removeAttribute(SHELL_ATTR);

    // Push history BEFORE applying so location.pathname is the NEW url when the
    // active-link hook reads it (popstate already has it updated). Whole-chain
    // morph doesn't read location, so this reorder is invisible there.
    if (push) history.pushState({ june: true }, "", href);
    const hash = new URL(href, location.href).hash;

    const apply = () => {
      // startViewTransition runs this callback ASYNCHRONOUSLY (after capture) —
      // a newer navigation may have started since it was scheduled. A stale
      // callback must be inert: it would morph a superseded response and, worse,
      // execute that page's scripts into the newer navigation's document.
      if (mine !== token) return;
      morph(current, next);
      // Only NOW is this page the one on screen. Recording it any earlier (at
      // pushState, say) would let a same-page popstate in the view-transition
      // gap dismiss this very apply as "already shown" — stranding the old DOM
      // under the new URL for good. Until here the old page stays the answer,
      // so such a popstate simply navigates again, which is correct.
      lastPage = pageKey();
      // Title BEFORE scripts: on a hard load the <head> title is parsed before
      // any body script runs, so activated scripts that read document.title
      // (analytics) must see the NEW page's value.
      if (title !== null) document.title = title;
      // Hard-nav parity: activate the fragment's (pending-stamped) scripts BEFORE
      // island hydration, mirroring a real page load where inline scripts run
      // ahead of the deferred islands bundle.
      executeScripts(current);
      rehydrate(current); // hydrate the new island markers (idempotent — skips live ones)
      updateActiveLinks(); // segment mode: move the shell's aria-current (no-op otherwise)
      landOn(hash); // `/page#section` lands on the section, like a hard load would
    };
    // View Transitions give the cross-fade for free where supported; elsewhere
    // (and in test DOMs) apply directly.
    const startVT = (document as unknown as {
      startViewTransition?: (cb: () => void) => unknown;
    }).startViewTransition;
    if (typeof startVT === "function") startVT.call(document, apply);
    else apply();
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element | null;
    const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    if ((a.target && a.target !== "_self") || a.hasAttribute("download") || a.hasAttribute("data-june-no-router")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || isHardNav(url)) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash, true);
  });

  window.addEventListener("popstate", () => {
    // Same page, different (or same) hash → a fragment navigation. The browser
    // owns those: it scrolled to the anchor already and the document is current.
    if (pageKey() === lastPage) {
      // …but a cross-page navigation may still be in flight: back to B, then
      // forward to here before B's fragment arrived. The document already shows
      // this page, so that response must never land — supersede and abort it,
      // exactly as a navigate() to this page would have.
      ++token;
      inflight?.abort();
      inflight = null;
      return;
    }
    navigate(location.pathname + location.search + location.hash, false);
  });
}
