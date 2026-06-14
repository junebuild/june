// Client islands — explicit, transform-free interactivity for v0.1.
//
// A page is server-rendered with zero client JS by default. To make ONE subtree
// interactive, an author marks the component `"use client"` (convention) and
// drops it into the server tree through `<Island>`. The server SSRs the
// component inside a `<june-island>` marker that also carries its props as JSON;
// the rest of the page ships no JS. The client runtime (Phase: hydration) scans
// for these markers, looks the component up in an explicit registry, and
// `hydrateRoot`s each one in place — so `useState`/`onClick` come alive without
// the page becoming an SPA.
//
// PURE: this is React-only (no `node:*` / `Bun.*`), so it lives in the contract
// layer and both the dev server and the built worker render identical markers.
//
// v0.1 is EXPLICIT: the author names the island and registers it on the client
// by hand. Auto-scanning `"use client"` files into a generated registry (so the
// `name` and the client import are derived, not written) is deferred to v0.2.
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

export type IslandProps<P extends Record<string, unknown> = Record<string, unknown>> = {
  // The registry key the client runtime hydrates against. Must match the key the
  // app registers in its client entry (v0.1: written by hand).
  name: string;
  // The component to SSR now and hydrate later — the SAME component runs in both
  // graphs, so its server markup and client tree match (no hydration mismatch).
  component: React.ComponentType<P>;
  // JSON-serializable props, embedded in the marker for the client to rehydrate.
  props?: P;
  // Carry this island's LIVE node across client-router navigations (see
  // ISLAND_PERSIST_ATTR). Only meaningful when `clientRouter` is on.
  persist?: boolean;
};

// Wrap a client component in its hydration marker. The marker SSRs the component
// (so the island is visible + indexable with zero JS) AND stamps the name +
// serialized props the client runtime needs to bring it to life.
export function Island<P extends Record<string, unknown>>({
  name,
  component: Component,
  props,
  persist,
}: IslandProps<P>): React.ReactElement {
  const resolved = (props ?? {}) as P;
  return React.createElement(
    ISLAND_TAG,
    {
      [ISLAND_NAME_ATTR]: name,
      [ISLAND_PROPS_ATTR]: serializeIslandProps(resolved),
      // Boolean attribute: present only when opted in, so non-persisted islands
      // (and apps without clientRouter) render byte-identical markers.
      ...(persist ? { [ISLAND_PERSIST_ATTR]: "" } : {}),
    },
    React.createElement(Component, resolved),
  );
}
