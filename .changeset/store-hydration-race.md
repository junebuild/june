---
"@junejs/core": patch
---

`useStore` hydrates against the store's INITIAL value (the true server snapshot), not the current one — fixing a hydration mismatch (React #418) when an island mutates the store before a later island hydrates.

Islands hydrate at different times (each loads its own chunk), so a user could click an already-live AddToCart before CartBadge hydrated; the badge would then hydrate against the moved store value while its SSR HTML still held the initial one. `createStore` now exposes `getInitial()` and `useStore` passes it as `getServerSnapshot`, so hydration always matches the SSR HTML and React re-renders to the current value right after. This also removes the same recoverable error on soft-navigation re-hydrates, and was the root cause of the flaky `store-e2e` test.
