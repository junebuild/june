// Client islands — the marker contract (transform-free).
//
// Authoring is via the JSX runtime: a `"use client"` component used with a
// `client:*` directive (`<Counter client:visible/>`) is emitted as a
// `<june-island>` marker by `@junejs/core/jsx-runtime` (no wrapper, no transform).
// This module is just the SHARED contract — the marker tag/attributes + prop
// (de)serialization + the Strategy type — imported by both the server (jsx-runtime)
// and the client (islands-client) so a rename can never desync the two halves.
//
// PURE: no `node:*` / `Bun.*`, so it lives in the contract layer and the dev server
// + built worker render identical markers.

export const ISLAND_TAG = "june-island";
export const ISLAND_NAME_ATTR = "data-june-island";
export const ISLAND_PROPS_ATTR = "data-june-props";
// When to bring the island to life (the `client:*` directive's value).
export const ISLAND_STRATEGY_ATTR = "data-june-strategy";
// Carry the island's live node across a client-router soft navigation: its
// already-hydrated node (React state, open sockets and all) is moved into the next
// page instead of re-created. No-op without `clientRouter`. The match key across
// pages is the island name, so a persisted island keeps the same name on every route.
export const ISLAND_PERSIST_ATTR = "data-june-persist";

// load    — hydrate immediately (the default)
// idle    — hydrate in requestIdleCallback (defer non-critical interactivity)
// visible — hydrate when scrolled into view (IntersectionObserver)
// only    — never SSR; mount fresh on the client (browser-only components)
export type Strategy = "load" | "idle" | "visible" | "only";

// Props cross the server→client boundary as JSON, so they must be JSON-serializable
// (no functions, no class instances). The empty object is the canonical "no props"
// value so the client can `JSON.parse` unconditionally.
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
