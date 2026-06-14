// The opt-in client router — June's progressive-enhancement SPA layer.
//
// OFF by default (config.clientRouter). When on, the document wraps the page in
// <div data-june-root> and the islands bundle calls startClientRouter() once.
// From then on, same-origin left-clicks become SOFT navigations: fetch the next
// URL — the SAME complete document the server already serves, no special payload
// format — replace the [data-june-root] region, re-hydrate the new islands, and
// carry any <Island persist> live node across. The agent surface is untouched:
// every URL is still a full, projectable (.md/.json/mcp) document.
//
// It degrades safely: no JS, a failed fetch, or an unrecognized response shape
// all fall back to a hard browser navigation — never a broken page.
//
// PURE per the contract layer's rule (no `node:*` / `Bun.*`); it is browser-only
// (touches `document`/`history`/`fetch`), so — like islands-client — it is
// exposed ONLY via the `@junejs/core/client-router` subpath and is NOT
// re-exported from the barrel.
import {
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PERSIST_ATTR,
} from "./islands";

// Called with each freshly swapped-in [data-june-root] so the host can hydrate
// the new page's islands (islands-client binds this to its registry).
export type Rehydrate = (root: ParentNode) => void;

const ROOT_ATTR = "data-june-root";
const rootEl = () => document.querySelector(`[${ROOT_ATTR}]`);

// Agent surfaces + non-HTML stay hard navigations — the same exclusions the
// speculation rules use (humans soft-navigate; a link to llms.txt must not).
function isHardNav(url: URL): boolean {
  return /\.(md|json|txt|xml)$/.test(url.pathname) || url.pathname === "/mcp";
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

  async function navigate(href: string, push: boolean): Promise<void> {
    const mine = ++token;
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;

    let html: string;
    try {
      const res = await fetch(href, { headers: { "x-june-nav": "1" }, signal: ac.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      html = await res.text();
    } catch (err) {
      // Aborted or superseded: a newer navigation owns the screen now — do
      // nothing. Otherwise the network/server actually failed: hand back to the
      // browser so the user still gets the page (or its real error).
      if ((err as { name?: string })?.name === "AbortError" || mine !== token) return;
      location.href = href;
      return;
    }
    if (mine !== token) return; // a newer navigation won the race — drop this result

    const doc = new DOMParser().parseFromString(html, "text/html");
    const incoming = doc.querySelector(`[${ROOT_ATTR}]`);
    const current = rootEl();
    if (!incoming || !current) {
      location.href = href; // a shape we don't recognize — let the browser handle it
      return;
    }

    const next = adopt(incoming);
    carryPersisted(current, next);

    const swap = () => {
      current.replaceWith(next);
      document.title = doc.title;
      rehydrate(next);
      window.scrollTo?.(0, 0);
    };
    // View Transitions give the cross-fade for free where supported; elsewhere
    // (and in test DOMs) swap directly.
    const startVT = (document as unknown as {
      startViewTransition?: (cb: () => void) => unknown;
    }).startViewTransition;
    if (typeof startVT === "function") startVT.call(document, swap);
    else swap();

    if (push) history.pushState({ june: true }, "", href);
  }

  // Move each persistent island's LIVE node from the outgoing tree into the
  // incoming one, replacing the freshly-parsed (inert) marker of the same name.
  // The moved node keeps its React root — state, effects, and open connections
  // (e.g. a websocket) survive the navigation. This is what June needs that the
  // spike got "for free": here the layout is INSIDE the swap region, so without
  // this nothing would persist.
  function carryPersisted(current: Element, next: Element): void {
    const sel = `${ISLAND_TAG}[${ISLAND_PERSIST_ATTR}]`;
    for (const live of Array.from(current.querySelectorAll(sel))) {
      const name = live.getAttribute(ISLAND_NAME_ATTR);
      if (!name) continue;
      const placeholder = next.querySelector(
        `${ISLAND_TAG}[${ISLAND_PERSIST_ATTR}][${ISLAND_NAME_ATTR}="${escapeAttr(name)}"]`,
      );
      if (placeholder) placeholder.replaceWith(live);
    }
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
    navigate(location.pathname + location.search + location.hash, false);
  });
}

// `replaceWith` auto-adopts in real browsers; adoptNode is belt-and-suspenders
// and some test DOMs need it explicit. Guarded so a DOM without it still works.
function adopt(node: Element): Element {
  return typeof document.adoptNode === "function" ? (document.adoptNode(node) as Element) : node;
}

// Island names are identifier-ish, but escape for the attribute selector anyway.
// Prefer the platform CSS.escape; fall back for older/test environments.
function escapeAttr(value: string): string {
  const css = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}
