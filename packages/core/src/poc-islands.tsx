// PoC: intent-based islands — the target authoring surface.
//
// Goal of this experiment: replace the verbose `<Island name component props/>`
// with DIRECT component usage that echoes the object name —
//
//     <Counter initial={0} />            // just use it
//     <Counter initial={0} client="visible" />   // explicit intent, per usage
//     <Tabs><Tab title="A">…</Tab></Tabs>        // server-rendered children (slot)
//
// HOW: `island(Component)` returns a thin server wrapper that emits the existing
// `<june-island>` marker (so morph / persist / the rest of the runtime keep
// working unchanged) PLUS a `data-june-strategy` attribute carrying the HYDRATION
// INTENT. Calling `island()` at module top level ALSO self-registers the raw
// component, so the client runtime needs no hand-written `{ name: Component }`
// map — importing the module is the registration (this is the v0.2 "derive the
// registry from the modules" idea, done explicitly for the PoC).
//
// PURE (React-only, no node:*/Bun.*) so it lives in the contract layer and SSRs
// identical markers in dev and the built worker.
import React from "react";

import {
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
  serializeIslandProps,
} from "./islands";

// The intent attribute — when to bring the island to life. Distinct from the
// legacy markers (which never carry it), so the two runtimes never fight over
// the same node (see the guard in islands-client.ts + hydrateIslandsAuto).
export const ISLAND_STRATEGY_ATTR = "data-june-strategy";
// Present when the island takes server-rendered children as a light-DOM slot.
export const ISLAND_SLOT_ATTR = "data-june-slot";

// load    — hydrate immediately (the default; same as today's eager islands)
// idle    — hydrate in requestIdleCallback (defer non-critical interactivity)
// visible — hydrate when scrolled into view (IntersectionObserver)
// only    — never SSR; mount fresh on the client (browser-only components)
export type Strategy = "load" | "idle" | "visible" | "only";

export type IslandEntry = {
  component: React.ComponentType<any>;
  strategy: Strategy;
  slot: boolean;
};

// The auto-registry: name → entry. Filled as a side effect of `island()` calls
// at module top level, shared by the marker emitter (server) and the hydration
// runtime (client) because both import THIS module.
export const POC_REGISTRY = new Map<string, IslandEntry>();

export type IslandOptions = {
  // Defaults to the component's name (the whole point — the marker echoes the
  // object). Pass explicitly only when the function is anonymous/minified.
  name?: string;
  strategy?: Strategy;
  // Opt in to taking server-rendered children as a light-DOM slot.
  slot?: boolean;
};

// Wrap a client component so it can be used DIRECTLY (`<Counter/>`). Returns a
// server component that renders the hydration marker; self-registers the raw
// component for the client runtime.
export function island<P extends Record<string, unknown>>(
  Component: React.ComponentType<P>,
  options: IslandOptions = {},
): React.ComponentType<P & { client?: Strategy; children?: React.ReactNode }> {
  const name = options.name ?? Component.displayName ?? Component.name;
  if (!name) {
    throw new Error(
      "[june/poc] island() needs a named component (or an explicit { name }) so the marker can echo it",
    );
  }
  const defaultStrategy: Strategy = options.strategy ?? "load";
  const slot = options.slot ?? false;
  // Register the RAW component — the client hydrates this, not the wrapper.
  POC_REGISTRY.set(name, { component: Component, strategy: defaultStrategy, slot });

  function IslandWrapper(props: P & { client?: Strategy }): React.ReactElement {
    // `client` is the per-usage intent override; `children` are the slot. Neither
    // crosses to the client as JSON props.
    const { client, children, ...rest } = props as P & {
      client?: Strategy;
      children?: React.ReactNode;
    };
    const strategy: Strategy = client ?? defaultStrategy;

    const markerProps: Record<string, unknown> = {
      [ISLAND_NAME_ATTR]: name,
      [ISLAND_PROPS_ATTR]: serializeIslandProps(rest),
      [ISLAND_STRATEGY_ATTR]: strategy,
      ...(slot ? { [ISLAND_SLOT_ATTR]: "" } : {}),
    };

    // SSR rules:
    //  - "only"     → never server-render (client-only); marker ships empty.
    //  - slot island → server-render ONLY the children (the panels), so the
    //    no-JS view shows them stacked and the client shell adopts them later
    //    without a hydration mismatch.
    //  - default    → server-render the component for a zero-JS-visible island.
    let inner: React.ReactNode = null;
    if (strategy !== "only") {
      inner = slot ? children : React.createElement(Component, rest as P, children);
    }
    return React.createElement(ISLAND_TAG, markerProps, inner);
  }
  IslandWrapper.displayName = `island(${name})`;
  return IslandWrapper;
}

// Server helper for slot panels: `<Tab title="X">…</Tab>` → a light-DOM section
// the client shell reads (title from the data attribute, content as-is).
export function Tab({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement("section", { "data-june-tab": title }, children);
}
