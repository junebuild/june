# Changelog

User-facing changes, newest first. The conventional-commit history is the source
of truth; this file summarizes what matters per release.

## [Unreleased]

### Added

- **Segment-scoped fragments — `<JuneOutlet>`.** A layout can opt into being a
  persistent shell: `export const segmentBoundary = true` and render
  `<JuneOutlet>` (`@junejs/core` / `@junejs/core/outlet`) around its `children`.
  With the opt-in client router on, a soft navigation then renders, sends, and
  morphs ONLY the content inside the outlet — the shell (sidebar/nav) is never
  re-rendered, re-serialized, or walked. For a large nested-layout site (e.g.
  docs with a big sidebar) this drops the per-navigation cost from O(shell) to
  O(content), without Flight/RSC (a granularity move, not a format one). The
  `segmentBoundary` export is a STATIC signal, so the server slices the layout
  chain without rendering the shell. Trade-off: the shell now sits outside the
  swap region, so the router reconciles its active-nav highlight (`aria-current`)
  from `location.pathname`. Deepest boundary wins; a second boundary in one chain
  warns. Whole-chain morph stays the default — existing sites are unaffected.

### Changed

- **`@junejs/core` — tunable View Transition duration.** Cross-document View
  Transitions now animate with a snappy **120 ms** cross-fade by default instead
  of the browser-default ~250 ms, which read as lag on a prerendered (instant)
  navigation — and dropped the hazy double-exposure mid-cross-fade. The
  `viewTransitions` config widens from `boolean` to `boolean | "instant" | number`:
  - `true` *(default)* — 120 ms cross-fade
  - a number — cross-fade duration in ms (`0` = instant cut)
  - `"instant"` — cross-document activation with no animation
  - `false` — no `@view-transition` rule at all

  `prefers-reduced-motion` still collapses to an instant cut. (Internally
  `VIEW_TRANSITION_CSS` becomes the `viewTransitionCss()` helper.)

### Docs

- **`docs/navigation-tiers.md`** (new) — the Tier 0/1/2 navigation strategy, and
  the orthogonal **format × granularity** axes (segment-scoped fragments are a
  granularity move on the HTML-morph track, not a Flight/RSC one).
- **`docs/model-eval-navigation.md`** (new) — a four-round model-robustness probe
  of the navigation design; records the failure modes and pins the in-flux
  platform facts (`no-store`/bfcache, cross-document View Transition dual opt-in).
- **`docs/runtime-convergence.md`** — added the format × granularity framing and a
  segment-scoped-fragment frontier item to the Route A plan.
- **Public docs** (`features-navigation`, `features-client-router`) — made the
  load-bearing browser behaviors explicit: bfcache + `no-store`, View Transition
  opt-in requirements, the `moveBefore` same-document boundary, and React-owned-DOM
  opacity.
