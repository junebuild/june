# Changelog

User-facing changes, newest first. The conventional-commit history is the source
of truth; this file summarizes what matters per release.

## [Unreleased]

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
