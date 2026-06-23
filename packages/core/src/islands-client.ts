// The client half of the islands contract — the hydration runtime.
//
// Bundled into the app's `client.js` (NOT the server/worker graph), it scans for
// `<june-island>` markers, loads each island's chunk ON ITS INTENT (the marker's
// `data-june-strategy`), and brings it to life in place. A marker is produced by
// the JSX runtime for a `"use client"` component used with a `client:*` directive;
// the loader (generated from that usage) returns the component to hydrate.
//
// PURE per the contract layer's rule (no `node:*` / `Bun.*`) — browser-only (touches
// `document` + `react-dom/client`), so it is exposed ONLY as the
// `@junejs/core/islands-client` subpath and never re-exported from the barrel.
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import {
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
  ISLAND_STRATEGY_ATTR,
  ISLAND_SLOT_ATTR,
  ISLAND_SLOT_TAG,
  JuneSlot,
  deserializeIslandProps,
} from "./islands";
import { startClientRouter } from "./client-router";
import { applyLiveUpdate } from "./client-live";
import { FRAGMENT_ACCEPT, SEGMENT_HEADER, TITLE_HEADER } from "./nav-protocol";

// Set on a marker once hydrated, so re-scanning a tree (the router re-hydrates each
// swapped page) never hydrates the same node twice — and a persisted island carried
// across a navigation, already live, is skipped.
type Marked = Element & { __juneHydrated?: boolean };

// A loader per island name: `{ Counter: () => import("./Counter").then(m => m.Counter) }`
// — the generated ISLAND_LOADERS. It resolves to the COMPONENT (typed unknown to
// match the generated map; cast on mount), and the import carries the island's code
// (its own chunk), so a page fetches only the chunks for the markers it rendered; a
// `visible`/`idle` island isn't requested until it fires.
export type IslandLoaders = Record<string, () => Promise<unknown>>;

function mount(el: Element, Component: React.ComponentType<any>): void {
  if ((el as Marked).__juneHydrated) return;
  (el as Marked).__juneHydrated = true;
  const props = deserializeIslandProps(el.getAttribute(ISLAND_PROPS_ATTR));
  const strategy = el.getAttribute(ISLAND_STRATEGY_ATTR);

  // Slot island: capture the server-rendered slot HTML and feed it back as the
  // children (the JuneSlot wrapper renders it opaquely), so the shell hydrates 1:1
  // and the server content is preserved verbatim. Nested island markers inside it
  // are found by the normal scan and self-hydrate. Always a hydrate (never SSR'd
  // empty: client:only + slot is rejected at build/render).
  if (el.hasAttribute(ISLAND_SLOT_ATTR)) {
    const slotEl = el.querySelector(ISLAND_SLOT_TAG);
    const html = slotEl ? slotEl.innerHTML : "";
    hydrateRoot(el, React.createElement(Component, { ...props, children: React.createElement(JuneSlot, { html }) }));
    // Foot-gun guard (dev only): a slot shell must HIDE its content (CSS / [hidden]),
    // never conditionally unmount it (`{open && children}`). Unmounting removes the
    // slot DOM — and the already-hydrated nested islands inside it die silently
    // (they won't be re-scanned). Warn if the slot node leaves the DOM.
    if (process.env.NODE_ENV !== "production" && slotEl && typeof MutationObserver !== "undefined") {
      const obs = new MutationObserver(() => {
        if (!el.contains(slotEl)) {
          obs.disconnect();
          console.warn(
            `[june] slot island "${el.getAttribute(ISLAND_NAME_ATTR)}" unmounted its content — ` +
              `toggle with CSS or the [hidden] attribute, not conditional rendering, or nested islands die silently.`,
          );
        }
      });
      obs.observe(el, { childList: true, subtree: true });
    }
    return;
  }
  // "only" was never SSR'd → mount fresh; otherwise adopt the server markup.
  if (strategy === "only") createRoot(el).render(React.createElement(Component, props));
  else hydrateRoot(el, React.createElement(Component, props));
}

// Fire `run` according to the marker's intent. The callback downloads (lazy) AND
// mounts — so the strategy gates BOTH the network request and the work.
function schedule(el: Element, run: () => void): void {
  const strategy = el.getAttribute(ISLAND_STRATEGY_ATTR) ?? "load";
  if (strategy === "idle" && "requestIdleCallback" in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(run);
  } else if (strategy === "visible" && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          obs.disconnect();
          run();
        }
      }
    });
    io.observe(el);
  } else {
    run(); // load, only, and any unknown/unsupported strategy → immediate
  }
}

// Bring every island marker under `root` to life via the generated loaders.
// Returns the count scheduled (handy for tests/diagnostics).
export function hydrateIslands(loaders: IslandLoaders, root: ParentNode = document): number {
  const markers = root.querySelectorAll(`${ISLAND_TAG}[${ISLAND_STRATEGY_ATTR}]`);
  let n = 0;
  for (const el of markers) {
    if ((el as Marked).__juneHydrated) continue;
    const name = el.getAttribute(ISLAND_NAME_ATTR);
    if (!name) continue;
    const load = loaders[name];
    if (!load) {
      console.warn(`[june] island "${name}" is on the page but has no loader in the registry`);
      continue;
    }
    schedule(el, () => {
      void load().then(
        (Component) => mount(el, Component as React.ComponentType<any>),
        (err) => console.error(`[june] failed to load island "${name}":`, err),
      );
    });
    n++;
  }
  return n;
}

// --- startJuneClient — the bootstrap (router + live-reload over island hydration)
//
// hydrateIslands is a pure PRIMITIVE (scan + schedule + mount). This is the
// BOOTSTRAP that wires it to the page: hydrate this page's islands, and — when the
// document opted into the client router ([data-june-root]) — start the router + the
// dev live-reload hook with a rehydrate that brings each soft-navigated page's
// islands to life. A persisted island (data-june-persist) is carried as a live node
// by morph and skipped by rehydrate (already `__juneHydrated`), so state survives.
//
// One entry point for an app's client.js:  startJuneClient({ loaders: ISLAND_LOADERS })
export type StartOptions = { loaders: IslandLoaders };

export function startJuneClient(options: StartOptions): void {
  const { loaders } = options;
  const rehydrate = (root: ParentNode): number => hydrateIslands(loaders, root);

  // 1. Bring this page's islands to life.
  rehydrate(document);

  // 2. Opt-in client router. The applier rides on [data-june-root] — "flight"
  //    (VDOM-over-wire, dynamically imported so react-server-dom stays out of morph
  //    bundles) vs the morph default. Flight is never the silent default.
  const routerRoot = document.querySelector("[data-june-root]");
  if (!routerRoot) return;

  if (routerRoot.getAttribute("data-june-router") === "flight") {
    void import("./client-router-flight").then(({ startFlightRouter }) => startFlightRouter());
    return;
  }

  startClientRouter(rehydrate);
  // Dev push-HMR hook: the injected dev-reload script calls this on reconnect
  // instead of location.reload() — re-fetch the current page's fragment and MORPH
  // it, so island state, focus, and scroll survive the edit. False → hard reload.
  (window as unknown as { __juneLiveReload?: () => Promise<boolean> }).__juneLiveReload =
    async () => {
      try {
        const res = await fetch(location.href, { headers: { accept: FRAGMENT_ACCEPT } });
        if (!res.ok) return false;
        return applyLiveUpdate(
          await res.text(),
          res.headers.get(TITLE_HEADER),
          rehydrate,
          res.headers.get(SEGMENT_HEADER), // segment-scoped → morph the outlet, not the root
        );
      } catch {
        return false;
      }
    };
}
