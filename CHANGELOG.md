# Changelog

User-facing changes, newest first. The conventional-commit history is the source
of truth; this file summarizes what matters per release.

## [Unreleased]

## [0.0.37]

### Added

- **Slot islands — an interactive shell wrapping server-rendered content.** A client
  island that renders `{children}` becomes a slot: the children are SSR'd as zero-JS
  HTML inside the island, and on hydrate the shell adopts that HTML verbatim
  (`dangerouslySetInnerHTML` + `suppressHydrationWarning`) — it hydrates 1:1, React
  never reconciles the content, and any nested islands inside it self-hydrate. No new
  API: the author just writes a `"use client"` component that renders `{children}`
  and uses it with children:

  ```tsx
  "use client";
  export function Viewer({ children }) {
    const [zoom, setZoom] = useState(1);
    return <div><button onClick={() => setZoom((z) => z + 1)}>{zoom}x</button>{children}</div>;
  }
  // page (server): the <article> stays zero-JS; Viewer's chrome hydrates
  <Viewer client:visible><article dangerouslySetInnerHTML={frozenHtml} /></Viewer>
  ```

  This replaces the 0.0.36 "islands can't take children" guard. Slot content is
  frozen server HTML; for children that share the shell's React state, make it one
  island or use a cross-island store. `client:only` + children is rejected (nothing
  is server-rendered to slot).

## [0.0.36]

Hardening of the jsx-runtime island model (0.0.35).

### Fixed

- **Islands with children no longer mismatch silently.** An island SSR'd its
  children but the client hydrates from the serialized props alone, so the children
  were dropped → hydration mismatch. Now fail-loud at both the build (the codegen
  rejects `<X client:*/>` with children) and at render. Composition via children
  needs RSC — make the children a separate client subtree.
- **An island module must be `"use client"`.** The codegen verifies a resolvable
  (relative) island module starts with the `"use client"` directive, so a
  server-only module (`node:*`, secrets) can't be pulled into the client bundle via
  its loader.

### Performance

- **The JSX runtime no longer taxes every render.** A fast path bails before any
  allocation unless a prop is a `client:*` directive, so non-island component
  renders cost only one cheap key scan.

### Known edge

- A renamed island export (`export { Foo as Counter }`) makes the marker name differ
  from the loader key → the island stays inert and warns. Keep the export name equal
  to the component's function name.

## [0.0.35]

The island layer's final form: a plain `"use client"` component used with a
`client:*` directive at the call site — **no wrapper, no transform**. `<Counter
client:visible/>` just works.

### Changed (BREAKING, pre-1.0)

- **Authoring is now `<Counter client:visible/>` on a PLAIN component.** Set
  `jsxImportSource: "@junejs/core"` (the new JSX runtime) and a `"use client"`
  component used with a `client:*` directive becomes an island automatically. This
  is the standard JSX factory the compiler already calls — **not** an AST transform.

  ```tsx
  // Counter.tsx — a plain "use client" React component (no island() wrapper)
  "use client";
  export function Counter({ initial = 0 }) { … }

  // page.tsx — hydration intent at the call site
  import { Counter } from "./Counter";
  <Counter initial={0} client:visible />
  ```

### Removed

- **`island()`, `Tab`, `hydrateIslandsAuto`, `hydrateIslandsLazy`,
  `ISLAND_REGISTRY`** and the light-DOM `slot` option. Replace `island()` wrappers
  with plain components + a `client:*` directive at each usage. The client runtime
  is now `hydrateIslands(loaders)` (wired by `startJuneClient`, unchanged).

### Added

- **Zero-setup library islands.** The registry is generated from USAGE
  (`<X client:*/>`) — the import specifier is resolved at the call site, so a
  third-party island works the same as an app one: ship ESM + declare `@junejs/core`
  as a peer, then `import { X } from "your-lib"; <X client:visible/>`. No manifest,
  no config list.
- **`@junejs/core/jsx-runtime`** + `/jsx-dev-runtime` — the island JSX runtime,
  with `client:load|idle|visible|only` (+ `persist`) typed on every component (a
  typo like `client:bogus` is a compile error).

### Migration

- `export const Counter = island(function Counter() {…})` →
  `export function Counter() {…}` (mark the module `"use client"`).
- `<Counter/>` → `<Counter client:load/>` (a `client:*` directive is now REQUIRED to
  make a usage an island).
- Set `"jsxImportSource": "@junejs/core"` in your `tsconfig.json`.

## [0.0.34]

Island v2 hardening — it can now fully replace the (now-removed) legacy `<Island>`.

### Removed

- **Legacy `<Island>` + `hydrateIslands(registry)`** (and `IslandProps`). The
  `island()` + generated-registry path is the only island model now. Migrate:
  `export const Counter = island(function Counter() {…})` and use `<Counter/>`.

### Added

- **`startJuneClient({ loaders })`** — the client bootstrap. `hydrateIslands`
  Auto/Lazy are pure primitives; startJuneClient wires the client router + dev
  live-reload with a v2-aware rehydrate, so island-v2 islands compose with
  `clientRouter` and re-hydrate after a soft navigation.
- **`island(C, { persist })`** — carry an island's live node (state, open
  connections) across a soft navigation (the v2 equivalent of the old
  `<Island persist>`).

### Fixed

- **Island registry codegen is AST-based** (oxc-parser). Loaders are keyed by the
  island's name from the `island()` call (matching the runtime), so an
  export-name/function-name mismatch can no longer silently fail to hydrate;
  multi-line/re-export forms are no longer missed; and a duplicate island name
  across modules is a build error instead of a silent overwrite.
- **`react-server-dom-webpack` is an optional peer dependency** — island-v2 apps
  no longer pull the RSC runtime they don't use.

## [0.0.33]

### Changed

- **`clientRouter` is now three-state** — `false | true|"morph" | "flight"`. `true`
  stays the morph (HTML-over-wire) applier (byte-identical output); `"flight"` is an
  explicit opt-in to the Flight applier. Flight is never the silent default.

### Deprecated

- **`<Island>` and `hydrateIslands(registry)`** — superseded by `island()` + the
  generated registry. Kept for one release; the `@junejs/core/poc-islands{,-client}`
  PoC subpaths are removed (import `island()` from `@junejs/core/islands`).

### Added

- **Island v2 — intent-based authoring (`@junejs/core/islands`).** Use a client
  component directly: `export const Counter = island(function Counter() {…})`, then
  `<Counter initial={0} />`. Declare hydration intent at the call site, Astro-style,
  with **typed** JSX directives (transform-free — the toolchain lowers
  `client:visible` to a prop the runtime reads): `client:load` (default),
  `client:idle`, `client:visible` (IntersectionObserver), `client:only` (no SSR,
  mount fresh). The intent gates **download**, not just hydration. Per-island
  **code-splitting** (one chunk per island, fetched only on the pages that render
  it) and an **auto-generated registry** from `island()` modules
  (`app/_islands.gen.ts`). Slot islands are **experimental** (the stable slot model
  is RSC).
- **Experimental — RSC build pipeline for standard targets.** Foundations for React
  Server Components on Cloudflare Workers / Vercel edge (no native runtime): the dual
  React graph via resolve conditions, `"use client"` → client-reference codegen,
  Flight → `<Document>` HTML, and per-route coexistence (`page.rsc.tsx`) with the
  SSR/island pipeline behind a path dispatcher. Opt-in; not yet wired as the
  deployed worker entry.
- **Experimental — `@junejs/i18n`, typed ICU messages (i18n phase 3).** A new
  opt-in package (Layer 2; locale routing is the in-box Layer 1). Author messages
  as ICU MessageFormat in `messages/<locale>.json` (or namespaced
  `messages/<locale>/<ns>.json` → `ns.key`); `june gen` compiles them to
  `app/_messages.ts` and a **typed `t`** whose key AND params are derived from the
  ICU AST — `t("cart.items", { n: number })`, where a wrong/missing param or
  unknown key is a compile error. CLDR plurals/select are correct per locale
  (`Intl.PluralRules`), and the **@formatjs parser runs only at build** — the
  request bundle ships the AST + a small evaluator, never a parser. `t` is
  ambient (reads `ctx.locale` off the request scope, no threading); `t.rich`
  renders embedded `<tag>`s to React nodes (`{ link: c => <a>{c}</a> }`); an
  island ships only the keys it uses via `pickMessages` + `clientTranslator`, so
  a page still ships zero message catalog. `@junejs/core` stays zero-dependency.

## [0.0.25] — 2026-06-16

### Added

- **Experimental — per-locale content collections (i18n phase 4).** A content
  collection can now be translated by locale: keep `content/<collection>/*.md` as
  the default-locale files (unchanged) and add `content/<collection>/<locale>/*.md`
  for variants — the content twin of the URL `default-unprefixed / locale-prefixed`
  split. The generated finder takes the locale (`post(slug, ctx.locale)`) and
  returns the variant when present, falling back to the default file otherwise (a
  dev-time warning flags a partial translation); a `posts(locale)` lister returns
  the collection localized. A collection with no `<locale>/` subdir emits exactly
  the previous shape, so single-locale apps are byte-identical. Pass
  `{ fallback: false }` to the finder for STRICT resolution — a missing variant
  returns null so a route can 404 rather than serve default-language content.

- **Experimental — hreflang + localized sitemap (i18n phase 4 SEO).** With `i18n`
  configured, every document head gets `rel="alternate" hreflang` links for its
  locale variants (incl. `x-default`, cross-origin absolute), and `/sitemap.xml`
  gains `xhtml:link` alternates per URL. These are the SEO CONTENT surface; the
  agent surfaces stay canonical single-language by design — a page's `.md`/`.json`
  follow its locale, but `llms.txt` / `/mcp` are not translated (tool contracts
  don't get translated). A new `examples/i18n` app dogfoods the whole stack.

### Changed

- **`@junejs/core` — cheaper segment-scoped active-link reconciliation.** The
  shell's `aria-current` hook now caches the shell-link set while the shell stays
  mounted instead of re-scanning the whole document (`querySelectorAll` +
  per-link `contains()`) on every soft navigation — an `O(all links)` per-nav cost
  on a large sidebar becomes a one-time scan reused across navigations. Behavior
  is unchanged (exact → `aria-current="page"`, ancestor → `"true"`, trailing
  slashes normalized). The active-link rule and its planned per-link declarative
  override (`data-june-active`) are documented in `docs/navigation-tiers.md`.

### Fixed

- **Content: a stray subdir can't become a phantom locale.** The content scanner
  now treats a `content/<collection>/<sub>/` directory as a locale bucket only
  when `<sub>` is a BCP-47-shaped tag (`de`, `fr`, `zh-TW` — not `images`,
  `drafts`, `assets`), so a misplaced folder no longer invents a ghost locale.

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
