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
import { morph } from "./morph";
import { FRAGMENT_ACCEPT, OUTLET_ATTR, SEGMENT_HEADER, SHELL_ATTR, TITLE_HEADER } from "./nav-protocol";

// Called with each freshly swapped-in region so the host can hydrate the new
// page's islands (islands-client binds this to its registry). In whole-chain
// mode this is [data-june-root]; in segment mode it is the [data-june-outlet].
export type Rehydrate = (root: ParentNode) => void;

const ROOT_ATTR = "data-june-root";
const rootEl = () => document.querySelector(`[${ROOT_ATTR}]`);
const outletEl = () => document.querySelector(`[${OUTLET_ATTR}]`);
// The key of the shell currently mounted (stamped on [data-june-root]). Null in
// whole-chain mode / non-boundary pages.
const mountedShellKey = () => rootEl()?.getAttribute(SHELL_ATTR) ?? null;

// Segment-scoped mode moves the shell (sidebar/nav, with its active-link state)
// OUTSIDE the swapped region, so morph no longer re-renders aria-current. This
// reconciles it from location.pathname — the trade the granularity optimization
// makes. No-op in whole-chain mode (no outlet), where morph already re-renders
// the shell. A shell link is active when it points at the current page OR an
// ancestor of it (section highlight), matching the common SSR convention. Uses
// the anchor's own parsed .origin/.pathname — no per-link allocation.
function updateActiveLinks(): void {
  const outlet = outletEl();
  if (!outlet) return; // whole-chain mode — morph carries aria-current for free
  const here = location.pathname;
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (outlet.contains(a)) continue; // inside the swap region — morph owns it
    if (a.origin !== location.origin) continue;
    const p = a.pathname;
    const active = p === here || (p !== "/" && here.startsWith(p.endsWith("/") ? p : p + "/"));
    if (active) a.setAttribute("aria-current", p === here ? "page" : "true");
    else if (a.hasAttribute("aria-current")) a.removeAttribute("aria-current");
  }
}

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
    let title: string | null = null;
    let fragmentShell: string | null = null; // SEGMENT_HEADER: the fragment's shell key (null = whole-chain)
    try {
      const res = await fetch(href, {
        headers: { accept: FRAGMENT_ACCEPT },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      html = await res.text();
      title = res.headers.get(TITLE_HEADER);
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

    // A segment-scoped fragment (SEGMENT_HEADER = the fragment's shell key) is
    // content-only — it morphs INTO the live [data-june-outlet], but ONLY when it
    // belongs to the shell currently mounted (its key matches [data-june-root]'s
    // data-june-shell). A cross-shell navigation, or a layout that declared
    // segmentBoundary yet forgot to render <JuneOutlet>, fails the match — we
    // hard-navigate so the correct shell loads instead of corrupting this one. A
    // whole-chain fragment (no header) morphs the whole [data-june-root].
    const segmented = fragmentShell !== null && fragmentShell === mountedShellKey();
    const current = segmented ? outletEl() : fragmentShell === null ? rootEl() : null;
    if (!current) {
      location.href = href;
      return;
    }
    // The fragment is the target's INNER html. Parse it into an inert clone of
    // the target, then morph the live target toward it in place.
    const next = current.cloneNode(false) as Element;
    next.innerHTML = html;

    // Push history BEFORE applying so location.pathname is the NEW url when the
    // active-link hook reads it (popstate already has it updated). Whole-chain
    // morph doesn't read location, so this reorder is invisible there.
    if (push) history.pushState({ june: true }, "", href);

    const apply = () => {
      morph(current, next);
      if (title !== null) document.title = title;
      rehydrate(current); // hydrate the new island markers (idempotent — skips live ones)
      updateActiveLinks(); // segment mode: move the shell's aria-current (no-op otherwise)
      window.scrollTo?.(0, 0);
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
    navigate(location.pathname + location.search + location.hash, false);
  });
}
