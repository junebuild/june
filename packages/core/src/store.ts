// Cross-island store — shared state across islands that are SEPARATE React roots.
//
// Islands each hydrate as their own root, so React Context can't connect them (a
// cart badge and an "add to cart" button, a theme/auth toggle and the rest of the
// page). A store is a module-level singleton that any island imports; `useStore`
// subscribes to it via `useSyncExternalStore`, so every island re-renders on change.
//
// CLIENT STATE by design. On the server each island renders the store's INITIAL
// value (the server snapshot) and nothing mutates it during SSR — so a long-lived
// worker never leaks one request's state into another. Seed per-request values via
// island PROPS (and set the store on the client), NEVER by mutating the store during
// a server render.
//
// Survives soft (morph) navigation: the module singleton outlives the page swap, so
// a cart/auth/theme store persists across pages; re-hydrated islands re-subscribe and
// read the current value.
//
// PURE (no `node:*` / `Bun.*`) — exposed as `@junejs/core/store`.
import { useSyncExternalStore } from "react";

export type Store<T> = {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(v, value)) return; // identical → no needless notify
      value = v;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Subscribe an island to a store. With a `selector`, the island re-renders only when
// the SELECTED slice changes — so a big store doesn't over-render every subscriber.
// The selector must return a primitive or a stable reference (the useSyncExternalStore
// contract): don't build a fresh object/array in it each call.
export function useStore<T>(store: Store<T>): [T, Store<T>["set"]];
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): [S, Store<T>["set"]];
export function useStore<T, S>(store: Store<T>, selector?: (state: T) => S): [T | S, Store<T>["set"]] {
  const getSnapshot: () => T | S = selector ? () => selector(store.get()) : store.get;
  const value = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return [value, store.set];
}
