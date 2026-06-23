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
import { createRoot, hydrateRoot } from "react-dom/client";

import {
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
  ISLAND_STRATEGY_ATTR,
  ISLAND_SLOT_ATTR,
  ISLAND_REGISTRY,
  deserializeIslandProps,
  type Strategy,
} from "./islands";
import { startClientRouter } from "./client-router";
import { applyLiveUpdate } from "./client-live";
import { FRAGMENT_ACCEPT, SEGMENT_HEADER, TITLE_HEADER } from "./nav-protocol";

// Set on a marker once hydrated, so re-scanning a tree (the client router
// re-hydrates each swapped page) never hydrates the same node twice — and a
// persistent island carried across a navigation, already live, is skipped.
type Marked = Element & { __juneHydrated?: boolean };

// (The legacy hand-written `hydrateIslands(registry)` + `<Island>` are gone — the
// island() + generated-registry path below is the only model.)

// --- intent-based runtime (paired with island()) -----------------------------
//
// Scans markers that carry `data-june-strategy` (the island() signature, never on
// legacy `<Island>` markers, so the two runtimes never touch the same node) and
// brings each to life ACCORDING TO ITS INTENT: now, on idle, on visible, or
// fresh-on-client.

// The component a slot island receives its lifted server panels through.
// EXPERIMENTAL — paired with island()'s `slot` option.
export type SlotProps = { __slot?: HTMLElement[] };

function mountFromRegistry(el: Element, name: string): void {
  if ((el as Marked).__juneHydrated) return;
  const entry = ISLAND_REGISTRY.get(name);
  if (!entry) {
    console.warn(`[june] island "${name}" is on the page but not registered (import its module)`);
    return;
  }
  const props = deserializeIslandProps(el.getAttribute(ISLAND_PROPS_ATTR));
  const strategy = (el.getAttribute(ISLAND_STRATEGY_ATTR) ?? "load") as Strategy;
  (el as Marked).__juneHydrated = true;

  if (el.hasAttribute(ISLAND_SLOT_ATTR)) {
    // Light-DOM slot: lift the server-rendered panels out, clear the marker, and
    // hand the nodes to the shell to place. createRoot (not hydrate) — the shell
    // is new client markup wrapping adopted DOM, not a 1:1 match of the server.
    const slot = Array.from(el.children) as HTMLElement[];
    el.replaceChildren();
    createRoot(el).render(React.createElement(entry.component, { ...props, __slot: slot }));
    return;
  }
  if (strategy === "only") {
    createRoot(el).render(React.createElement(entry.component, props)); // never SSR'd → fresh
    return;
  }
  hydrateRoot(el, React.createElement(entry.component, props)); // adopt the server markup
}

// Fire `run` according to the marker's intent. The callback is what downloads
// (lazy) and/or mounts the island — so the strategy gates BOTH the network
// request and the work, not just the hydration.
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
    run(); // load, only, slot, and any unknown/unsupported strategy → immediate
  }
}

// EAGER: components already imported (via island() import side-effects). Brings
// every intent-bearing island under `root` to life. Returns the count scheduled.
export function hydrateIslandsAuto(root: ParentNode = document): number {
  const markers = root.querySelectorAll(`${ISLAND_TAG}[${ISLAND_STRATEGY_ATTR}]`);
  let n = 0;
  for (const el of markers) {
    if ((el as Marked).__juneHydrated) continue;
    const name = el.getAttribute(ISLAND_NAME_ATTR);
    if (!name) continue;
    schedule(el, () => mountFromRegistry(el, name));
    n++;
  }
  return n;
}

// A lazy loader per island name: `{ Counter: () => import("./Counter") }` — the
// generated ISLAND_LOADERS. The import carries the island's code (its own chunk),
// so a page fetches only the chunks for the markers it rendered, and a
// `visible`/`idle` island is not even requested until its trigger fires.
export type IslandLoaders = Record<string, () => Promise<unknown>>;

// LAZY: download each island's chunk ON ITS INTENT, then mount it. Importing the
// chunk runs its `island()` call (self-registering into ISLAND_REGISTRY);
// mountFromRegistry then brings it to life.
export function hydrateIslandsLazy(loaders: IslandLoaders, root: ParentNode = document): number {
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
        () => mountFromRegistry(el, name),
        (err) => console.error(`[june] failed to load island "${name}":`, err),
      );
    });
    n++;
  }
  return n;
}

// --- startJuneClient — the bootstrap (router + live-reload over island hydration)
//
// hydrateIslandsAuto/Lazy are pure PRIMITIVES (scan + schedule + mount). This is
// the BOOTSTRAP that wires them to the page: hydrate the islands now, and — when
// the document opted into the client router ([data-june-root]) — start the router
// and the dev live-reload hook with a rehydrate that brings each soft-navigated
// page's islands to life. A persisted island (data-june-persist) is carried as a
// live node by morph and skipped by rehydrate (already `__juneHydrated`), so its
// state survives the navigation.
//
// One entry point for an app's client.js:  startJuneClient({ loaders: ISLAND_LOADERS })
export type StartOptions = {
  // The generated lazy registry. Omit to hydrate already-imported islands eagerly.
  loaders?: IslandLoaders;
};

export function startJuneClient(options: StartOptions = {}): void {
  const { loaders } = options;
  const rehydrate = (root: ParentNode): number =>
    loaders ? hydrateIslandsLazy(loaders, root) : hydrateIslandsAuto(root);

  // 1. Bring this page's islands to life.
  rehydrate(document);

  // 2. Opt-in client router: the document renders [data-june-root] only when
  //    clientRouter is not "off". The applier rides on the element — "flight"
  //    (VDOM-over-wire, dynamically imported so react-server-dom stays out of
  //    morph bundles) vs the morph default. Flight is never the silent default.
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
