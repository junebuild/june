# Changelog

User-facing changes, newest first. The conventional-commit history is the source
of truth; this file summarizes what matters per release.

## [Unreleased]

### Changed

- **`@junejs/core` — cheaper segment-scoped active-link reconciliation.** The
  shell's `aria-current` hook now caches the shell-link set while the shell stays
  mounted instead of re-scanning the whole document (`querySelectorAll` +
  per-link `contains()`) on every soft navigation — an `O(all links)` per-nav cost
  on a large sidebar becomes a one-time scan reused across navigations. Behavior
  is unchanged (exact → `aria-current="page"`, ancestor → `"true"`, trailing
  slashes normalized). The active-link rule and its planned per-link declarative
  override (`data-june-active`) are documented in `docs/navigation-tiers.md`.

## [0.0.24] — 2026-06-16

### Fixed

- **Dev live-reload no longer saturates the browser's connection pool.** In MPA
  mode every navigation is a full reload that opens a fresh live-reload
  `EventSource`; the old connection was never closed, and since each held SSE
  consumes one of the browser's ~6 HTTP/1.1 slots per host, rapid navigation
  exhausted them — subsequent page loads stalled (pending) or 503'd. The
  injected reload client now closes its `EventSource` on `pagehide`, releasing
  the slot before the next page opens its own.

## [0.0.23] — 2026-06-16

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
  chain without rendering the shell. Each shell has an identity KEY: the server
  stamps it on `[data-june-root]` (`data-june-shell`) and sends it as the soft-nav
  header, so the client morphs a content-only fragment into the outlet ONLY when
  it belongs to the shell currently mounted — a cross-shell navigation (docs →
  blog), or a layout that declared `segmentBoundary` but forgot `<JuneOutlet>`,
  hard-navigates instead of corrupting the page. The dev/HMR live-update path is
  shell-aware for the same reason. The shell's active-nav highlight is reconciled
  from `location.pathname` (exact → `aria-current="page"`, ancestor →
  `aria-current="true"`). Deepest boundary wins; a second boundary in one chain
  warns. A boundary layout must keep route-dependent context AT OR BELOW
  `<JuneOutlet>` (the shell isn't re-rendered on soft-nav). Whole-chain morph
  stays the default — existing sites are unaffected.

- **Experimental — locale routing (i18n phase 1).** Opt in with `i18n` in
  `june.config.ts` to light up host/path → locale resolution, `ctx.locale`, and
  `localeHref`; the resolved locale drives `<html lang>` / `dir` on every
  document. This is ROUTING ONLY — the message catalog is still future
  (`@junejs/i18n`), so treat it as the foundation, not a finished i18n story. Omit
  the config and June does no locale handling (byte-identical to before).

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
