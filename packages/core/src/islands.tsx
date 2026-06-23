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
import { createElement, type ReactElement, type ReactNode } from "react";

export const ISLAND_TAG = "june-island";
export const ISLAND_NAME_ATTR = "data-june-island";
export const ISLAND_PROPS_ATTR = "data-june-props";
// When to bring the island to life (the `client:*` directive's value).
export const ISLAND_STRATEGY_ATTR = "data-june-strategy";
// Present when an island wraps server-rendered children as a slot (it took
// children). The element below carries that content across the SSR→hydrate boundary.
export const ISLAND_SLOT_ATTR = "data-june-slot";
export const ISLAND_SLOT_TAG = "june-slot";
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

// The slot boundary an island's children pass through — the SAME component on both
// sides of the SSR→hydrate boundary, so it renders byte-identical markup:
//  - SERVER: render the children normally → zero-JS HTML inside `<june-slot>`.
//  - CLIENT: render the captured server HTML opaquely (dangerouslySetInnerHTML +
//    suppressHydrationWarning). Same string → hydration aligns; React never
//    reconciles inside, so the content stays the server's zero-JS HTML and any
//    nested island markers within it survive to self-hydrate.
// Internal: the JSX runtime (server) and islands-client (client) substitute an
// island's `children` with this — the author just renders `{children}`.
//
// AUTHOR CONSTRAINTS (the two costs of a slot island):
//  1. The slot content is INERT — frozen server HTML. Children that need to share
//     the shell's React state must be a nested island or use a cross-island store.
//  2. The shell must HIDE the slot (CSS / [hidden]), never conditionally UNMOUNT it
//     (`{open && children}`) — unmounting destroys the nested islands inside it.
//     (islands-client warns in dev if a slot's content is removed from the DOM.)
export function JuneSlot({ children, html }: { children?: ReactNode; html?: string }): ReactElement {
  if (html != null) {
    return createElement(ISLAND_SLOT_TAG, { dangerouslySetInnerHTML: { __html: html }, suppressHydrationWarning: true });
  }
  return createElement(ISLAND_SLOT_TAG, null, children);
}
