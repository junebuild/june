// Client islands — transform-free interactivity.
//
// A page is server-rendered with zero client JS by default. To make ONE subtree
// interactive, mark the component `"use client"` and wrap it with `island()`; use
// it directly (`<Counter/>`) with its hydration intent at the call site
// (`client:visible`). The server SSRs it inside a `<june-island>` marker carrying
// its props (+ intent) as attributes; the client runtime scans the markers, looks
// each up in the registry (auto-generated from the modules), and brings it to life.
//
// PURE: React-only (no `node:*` / `Bun.*`), so it lives in the contract layer and
// both the dev server and the built worker render identical markers.
import React from "react";

// The marker element + attributes are the contract between this server-side
// primitive and the client hydration runtime. Both sides import these constants
// so a rename can never desync the two halves.
export const ISLAND_TAG = "june-island";
export const ISLAND_NAME_ATTR = "data-june-island";
export const ISLAND_PROPS_ATTR = "data-june-props";
// Marks an island to be CARRIED across a client-router soft navigation: its
// live, already-hydrated node (React state, open sockets and all) is moved into
// the next page instead of re-created. No-op without `clientRouter`. The match
// key across pages is the island `name`, so a persisted island must keep the
// same name on every route it appears on.
export const ISLAND_PERSIST_ATTR = "data-june-persist";

// Props cross the server→client boundary as JSON, so they must be
// JSON-serializable (no functions, no class instances) — the v0.1 island
// contract. The empty object is the canonical "no props" value so the client
// can `JSON.parse` unconditionally.
export function serializeIslandProps(props: unknown): string {
  return JSON.stringify(props ?? {});
}

export function deserializeIslandProps(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// --- island() — intent-based authoring -----------------------------------------
//
// Use a client component DIRECTLY, with its hydration intent at the call site:
//
//     export const Counter = island(function Counter() { … });
//     <Counter initial={0} />              // hydrate on load (default)
//     <Counter initial={0} client:visible />  // hydrate when scrolled into view
//
// `island()` returns a server wrapper that emits the same `<june-island>` marker
// (morph / persist keep working) PLUS a `data-june-strategy` carrying the intent,
// and self-registers the raw component so the client runtime needs no hand-written
// map — the build derives the registry from the modules (see generateIslandRegistry).

// The intent attribute — when to bring the island to life. The legacy `<Island>`
// markers never carry it, so the two client runtimes never fight over a node.
export const ISLAND_STRATEGY_ATTR = "data-june-strategy";
// Present when the island takes server-rendered children as a light-DOM slot.
// EXPERIMENTAL — the stable slot model is RSC; this light-DOM form may change.
export const ISLAND_SLOT_ATTR = "data-june-slot";

// load    — hydrate immediately (the default)
// idle    — hydrate in requestIdleCallback (defer non-critical interactivity)
// visible — hydrate when scrolled into view (IntersectionObserver)
// only    — never SSR; mount fresh on the client (browser-only components)
export type Strategy = "load" | "idle" | "visible" | "only";

export type IslandEntry = {
  component: React.ComponentType<any>;
  strategy: Strategy;
  slot: boolean;
};

// The registry: name → entry, filled as a side effect of `island()` at module top
// level, shared by the marker emitter (server) and the hydration runtime (client)
// because both import THIS module.
export const ISLAND_REGISTRY = new Map<string, IslandEntry>();

export type IslandOptions = {
  // Defaults to the component's name (so the marker echoes the object). Pass
  // explicitly only when the function is anonymous/minified.
  name?: string;
  strategy?: Strategy;
  // Carry this island's LIVE node across client-router soft navigations (its React
  // state + open connections survive instead of being re-created). Only meaningful
  // with clientRouter; the match key across pages is the island name.
  persist?: boolean;
  // EXPERIMENTAL: take server-rendered children as a light-DOM slot.
  slot?: boolean;
};

// The Astro-style hydration directives, expressed as JSX NAMESPACED attributes
// (`<Counter client:visible/>`). NOT a transform: the toolchain (Bun, tsc,
// rolldown/oxc) already lowers `client:visible` to the string-keyed prop
// `"client:visible": true`, so the wrapper reads it at runtime. Typing them here
// makes tsc validate the directive (a typo like `client:bogus` errors).
export type IslandIntent = { [K in `client:${Strategy}`]?: boolean };
const INTENT_KEYS = ["client:load", "client:idle", "client:visible", "client:only"] as const;

export function island<P extends Record<string, unknown>>(
  Component: React.ComponentType<P>,
  options: IslandOptions = {},
): React.ComponentType<P & IslandIntent & { children?: React.ReactNode }> {
  const name = options.name ?? Component.displayName ?? Component.name;
  if (!name) {
    throw new Error(
      "[june] island() needs a named component (or an explicit { name }) so the marker can echo it",
    );
  }
  const defaultStrategy: Strategy = options.strategy ?? "load";
  const slot = options.slot ?? false;
  const persist = options.persist ?? false;
  // Register the RAW component — the client hydrates this, not the wrapper.
  ISLAND_REGISTRY.set(name, { component: Component, strategy: defaultStrategy, slot });

  function IslandWrapper(props: P & IslandIntent & { children?: React.ReactNode }): React.ReactElement {
    const { children, ...rest } = props as P & IslandIntent & { children?: React.ReactNode };
    // Per-usage intent: the truthy `client:<strategy>` directive wins; strip every
    // directive key so it never reaches the component or the serialized props.
    let chosen: Strategy | undefined;
    for (const key of INTENT_KEYS) {
      if (key in rest) {
        if ((rest as Record<string, unknown>)[key]) chosen = key.slice("client:".length) as Strategy;
        delete (rest as Record<string, unknown>)[key];
      }
    }
    const strategy: Strategy = chosen ?? defaultStrategy;

    const markerProps: Record<string, unknown> = {
      [ISLAND_NAME_ATTR]: name,
      [ISLAND_PROPS_ATTR]: serializeIslandProps(rest),
      [ISLAND_STRATEGY_ATTR]: strategy,
      ...(persist ? { [ISLAND_PERSIST_ATTR]: "" } : {}),
      ...(slot ? { [ISLAND_SLOT_ATTR]: "" } : {}),
    };

    // SSR rules:
    //  - "only"     → never server-render (client-only); marker ships empty.
    //  - slot island → server-render ONLY the children (the panels); the client
    //    shell adopts them later without a hydration mismatch.
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

// EXPERIMENTAL slot helper: `<Tab title="X">…</Tab>` → a light-DOM section the
// client shell reads (title from the data attribute, content as-is).
export function Tab({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement("section", { "data-june-tab": title }, children);
}
