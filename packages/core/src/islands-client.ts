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
    hydrated++;
  }
  return hydrated;
}
