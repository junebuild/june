// The client half of the islands contract — the hydration runtime.
//
// Bundled into the app's `client.js` (NOT the server/worker graph), it runs once
// after the document parses: scan for `<june-island>` markers, look each up in
// the app's explicit registry, and `hydrateRoot` it in place. The server already
// SSR'd the markup, so hydration only attaches behavior — `useState`, `onClick` —
// with no flash and no mismatch (same component, same props, both graphs).
//
// PURE per the contract layer's rule (no `node:*` / `Bun.*`) — it is browser-only
// (it touches `document` + `react-dom/client`), so it is exposed ONLY as the
// `@junejs/core/islands-client` subpath and is deliberately NOT re-exported from the
// barrel: pulling `react-dom/client` into the worker graph is exactly what we
// must not do.
import React from "react";
import { hydrateRoot } from "react-dom/client";

import {
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
  deserializeIslandProps,
} from "./islands";
import { startClientRouter } from "./client-router";
import { applyLiveUpdate } from "./client-live";
import { FRAGMENT_ACCEPT, SEGMENT_HEADER, TITLE_HEADER } from "./nav-protocol";

// Set on a marker once hydrated, so re-scanning a tree (the client router
// re-hydrates each swapped page) never hydrates the same node twice — and a
// persistent island carried across a navigation, already live, is skipped.
type Marked = Element & { __juneHydrated?: boolean };

// The app maps each island `name` to its component. v0.1 is explicit: the app
// writes this by hand in its client entry. v0.2 generates it from `"use client"`.
export type IslandRegistry = Record<string, React.ComponentType<any>>;

// Hydrate every island marker found under `root` (the whole document by default).
// Returns the count hydrated — handy for tests and dev diagnostics.
export function hydrateIslands(
  registry: IslandRegistry,
  root: ParentNode = document,
): number {
  const markers = root.querySelectorAll(`${ISLAND_TAG}[${ISLAND_NAME_ATTR}]`);
  let hydrated = 0;
  for (const el of markers) {
    if ((el as Marked).__juneHydrated) continue; // already live (e.g. carried across a nav)
    // PoC intent-based islands carry data-june-strategy and are owned by
    // hydrateIslandsAuto — never double-hydrate them from the legacy registry.
    if (el.hasAttribute("data-june-strategy")) continue;
    const name = el.getAttribute(ISLAND_NAME_ATTR);
    if (!name) continue;
    const Component = registry[name];
    if (!Component) {
      // Explicit registry: an unregistered island is an author mistake (forgot to
      // add it to the client entry), so surface it instead of silently leaving a
      // dead, non-interactive marker on the page.
      console.warn(`[june] island "${name}" is on the page but not registered for hydration`);
      continue;
    }
    const props = deserializeIslandProps(el.getAttribute(ISLAND_PROPS_ATTR));
    hydrateRoot(el as Element, React.createElement(Component, props));
    (el as Marked).__juneHydrated = true;
    hydrated++;
  }

  // Opt-in client router: the document renders [data-june-root] only when
  // config.clientRouter is not "off", and only the full-document boot call
  // (root === document) should start it — re-hydrations of swapped subtrees pass
  // the new root, not the document. Bind the router's re-hydrate to THIS registry
  // so every soft-navigated page brings its islands to life.
  const routerRoot = root === document ? document.querySelector("[data-june-root]") : null;
  if (routerRoot) {
    const rehydrate = (swapped: ParentNode) => hydrateIslands(registry, swapped);
    // The applier rides on the root element: data-june-router="flight" means the
    // author opted into Flight (VDOM-over-wire); its absence means morph (the
    // HTML-over-wire default). Flight is gated here so it can NEVER be the silent
    // default — it only runs when the document explicitly named it. The Flight
    // module is DYNAMICALLY imported so react-server-dom is pulled into the bundle
    // ONLY for flight-opted apps; morph users never pay that coupling.
    if (routerRoot.getAttribute("data-june-router") === "flight") {
      void import("./client-router-flight").then(({ startFlightRouter }) =>
        startFlightRouter(),
      );
    } else {
      startClientRouter(rehydrate);
    }
    // Dev push-HMR hook: the injected dev-reload script calls this on reconnect
    // after a restart instead of location.reload() — re-fetch the current page's
    // fragment and MORPH it (preserveIslands:"all"), so island state, focus, and
    // scroll survive the edit. Returns false (caller hard-reloads) on any miss.
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
  return hydrated;
}
