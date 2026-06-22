// PoC: the client half of intent-based islands — the scheduling hydration
// runtime. Bundled into the app's client.js (NOT the worker graph), it scans for
// markers that carry `data-june-strategy` (the PoC's signature, so it never
// touches legacy `<Island>` markers) and brings each to life ACCORDING TO ITS
// INTENT: now, on idle, on visible, or fresh-on-client.
//
// Browser-only (touches document + react-dom/client), so exposed only as the
// `@junejs/core/poc-islands-client` subpath, never re-exported from the barrel.
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import { ISLAND_TAG, ISLAND_NAME_ATTR, ISLAND_PROPS_ATTR, deserializeIslandProps } from "./islands";
import {
  POC_REGISTRY,
  ISLAND_STRATEGY_ATTR,
  ISLAND_SLOT_ATTR,
  type Strategy,
} from "./poc-islands";

type Marked = Element & { __juneHydrated?: boolean };

// The component a slot island receives its lifted server panels through.
export type SlotProps = { __slot?: HTMLElement[] };

function mountFromRegistry(el: Element, name: string): void {
  if ((el as Marked).__juneHydrated) return;
  const entry = POC_REGISTRY.get(name);
  if (!entry) {
    console.warn(`[june/poc] island "${name}" is on the page but not registered (import its module)`);
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
    // Never SSR'd → mount fresh.
    createRoot(el).render(React.createElement(entry.component, props));
    return;
  }
  // Default: adopt the server markup in place.
  hydrateRoot(el, React.createElement(entry.component, props));
}

// Fire `run` according to the marker's intent: now, on idle, or on visible. The
// callback is what downloads (lazy) and/or mounts the island — so the strategy
// gates BOTH the network request and the work, not just the hydration.
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
    // load, only, slot, and any unknown/unsupported strategy → immediate.
    run();
  }
}

// EAGER registry: components already imported (e.g. via import side-effects).
// Brings every intent-bearing island under `root` to life. Returns the count
// scheduled (handy for tests/diagnostics).
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

// A lazy loader per island name: `{ Counter: () => import("./Counter") }`. The
// import is what carries the island's code — split into its own chunk — so a
// page fetches only the chunks for the markers it actually rendered.
export type IslandLoaders = Record<string, () => Promise<unknown>>;

// LAZY registry: download each island's chunk ON ITS INTENT, then mount it. This
// is the splitting payoff — a page never downloads an island it does not show,
// and a `visible`/`idle` island is not even requested until its trigger fires.
// Importing the chunk runs its `island()` call, which self-registers the raw
// component into POC_REGISTRY; mountFromRegistry then brings it to life.
export function hydrateIslandsLazy(loaders: IslandLoaders, root: ParentNode = document): number {
  const markers = root.querySelectorAll(`${ISLAND_TAG}[${ISLAND_STRATEGY_ATTR}]`);
  let n = 0;
  for (const el of markers) {
    if ((el as Marked).__juneHydrated) continue;
    const name = el.getAttribute(ISLAND_NAME_ATTR);
    if (!name) continue;
    const load = loaders[name];
    if (!load) {
      console.warn(`[june/poc] island "${name}" is on the page but has no loader in the registry`);
      continue;
    }
    schedule(el, () => {
      void load().then(
        () => mountFromRegistry(el, name),
        (err) => console.error(`[june/poc] failed to load island "${name}":`, err),
      );
    });
    n++;
  }
  return n;
}
