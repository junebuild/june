# Navigation tiers — how June swaps pages

June's navigation story is not one mechanism but a ladder, and the floor is the
browser. This doc states the tiers, what each buys and costs, and the two axes —
wire *format* × wire *granularity* — that the
[Route A plan](./runtime-convergence.md#the-client-apply-layer--route-a-embrace-react-morph-the-shell)
forks on only one of. It is the design reference behind `clientRouter`,
`morph.ts`, and the `fragment` projection.

## The principle

A client router is the single biggest source of accidental JavaScript: the
router pulls in state, the state pulls in hydration, and a document site ends up
shipping a runtime. So June's default is to ship none and let the browser
navigate — and to climb a tier only when a surface genuinely needs what the tier
below can't give.

One invariant holds at every tier: **every URL stays a complete, projectable
document** (`.md` / `.json` / `/mcp` untouched). Navigation is a human-surface
concern; the agent surface never forks.

## The tiers

### Tier 0 — browser-native (the floor, zero JS)

First load is HTML; navigation is a real full-document navigation made **instant**
by prerender and **smooth** by View Transitions. No router, no client state, ~1KB
of declarative rules. `features-navigation.md` is the public face; june.build
itself runs here.

- **Mechanism.** Speculation Rules prerender same-origin links on hover
  (`eagerness: moderate`) so the click is a zero-network activation; a
  `pointerover → <link rel=prefetch>` fallback covers browsers without it;
  `@view-transition { navigation: auto }` paints the document swap as one
  continuous surface; bfcache makes back/forward instant.
- **Gives.** Per-page server-rendered active highlight is free and correct (each
  page renders its own `aria-current`). An active indicator carrying a
  `view-transition-name` even *slides* between menu items across navigations,
  purely declaratively.
- **Can't.** Preserve the *live state* of a region across a navigation — each nav
  is a fresh document. A long, internally-scrolled (`overflow:auto`) sidebar
  resets to top; an open websocket is torn down. (The main document's scroll is
  restored by the browser; an inner scroll container's is not.)
- **Climb when.** That lost state is the product.

### Tier 1 — clientRouter morph (HTML-over-the-wire) — IMPLEMENTED

`clientRouter: true`. Same-origin clicks become **soft swaps**: fetch the
`fragment` projection (the *same* URL, `text/vnd.june.fragment+html`), then morph
it into `[data-june-root]`. htmx / Turbo 8 / Phoenix LiveView class.

- **Files.** `client-router.ts` (nav, race token, popstate, degrade),
  `morph.ts` (island-opaque applier, `moveBefore` state-preserving reparent),
  `nav-protocol.ts` (media type + title header), `renderFragment`
  (`pipeline.ts`). `features-client-router.md` is the public face.
- **Gives.** Unchanged nodes keep identity → sidebar scroll, focus, selection,
  form input, CSS transitions, and `<Island persist>` React state (open socket
  included) survive a navigation. No second wire format; degrades to a hard nav;
  the agent surface is untouched.
- **Costs.** The islands runtime ships. And — today — granularity is whole-chain
  (see [The two axes](#the-two-axes)).
- **Position.** The opt-in for app-like surfaces that need in-memory state to
  outlive a nav — **not** a docs-perf knob. Off by default; this site keeps it
  off.

### Tier 2 — Flight reconcile (VDOM-over-the-wire) — OPT-IN, PLANNED

Render the route through the server React graph to a Flight stream; the client
reconciles it in place. The native-runtime track
([Route A](./runtime-convergence.md)) builds the server-side generation; the
client still applies morph by default and reaches for Flight per route.

- **Gives over Tier 1.** Finer-grained streamed reconcile; preserves a layout's
  *client* React state by architecture.
- **Costs.** Couples the framework to `react-server-dom` + client references and
  ships a payload that is NOT a projectable document.
- **Why not the docs default.** The runtime + coupling fight the zero-JS floor
  and the projectable-document invariant — and docs sidebars are static, so the
  client-state preservation it buys is rarely the thing a docs site needs.

## The two axes

The Route A fork is about wire **format** (HTML-morph vs Flight-VDOM). It is
orthogonal to wire **granularity** — how much of the chain a navigation
re-renders and ships. The plan forks on the first and has held the second
constant.

| axis | options | today |
| --- | --- | --- |
| **format** | HTML fragment (morph) · Flight (reconcile) | morph default, Flight opt-in |
| **granularity** | whole `[data-june-root]` chain · changed segment only | fixed at whole chain |

Today `renderFragment` flattens the whole layout chain into one
`[data-june-root]` payload and morphs it wholesale — fine for a short shell, a
tax for a large nested-layout site: a 1000-link docs sidebar is re-serialized and
re-walked on every soft-nav even though only the content segment changed. It
survives via morph identity, but the wire + server-render + walk are all
O(shell).

The win — *only swap the content, never touch the sidebar* — is a **granularity**
move, not a **format** one. A **segment-scoped fragment** renders only the
changed segment below the persistent layout boundary; the client morphs only the
content region. That is per-segment granularity on the HTML-morph track — RSC's
docs-relevant benefit without Flight. The axes compose: morph (default format) ×
segment-scoped (opt-in granularity).

## Active highlight × scroll — the trade-off that drives the tier choice

| strategy | active highlight | sidebar internal scroll |
| --- | --- | --- |
| Tier 0 full nav (shell re-rendered per page) | free + correct | resets (unless a ~10-line `sessionStorage` save/restore) |
| Tier 1 whole-chain morph | free — morph re-renders the shell, `aria-current` updates | preserved — unchanged nodes keep identity |
| Tier 1 + segment-scoped (shell outside the swap) | needs a `location`-driven `aria-current` hook | preserved — shell never touched |

The whole-chain morph is the only row that gets **both** for free — that is
exactly the cost the segment-scoped optimization trades away: a shell outside the
swap region has to move its own highlight. Decide per surface, eyes open.

### The active-link reconciliation rule (segment-scoped)

The `location`-driven hook (`updateActiveLinks` in `client-router.ts`) sets
`aria-current` on shell links using a fixed convention: a link is **`"page"`**
when its path equals the current path, **`"true"`** when the current path is
under it (an ancestor/section link), and cleared otherwise. Trailing slashes are
normalized first (June doesn't redirect `/guide/` → `/guide`). The shell-link set
is scanned once and cached while the shell stays mounted.

This is a **client-side default**, and it is a *second* source of truth alongside
whatever the shell's SSR template emitted on the hard load — the two can disagree
when the author's intent isn't "exact-or-ancestor" (e.g. exact-only, a curated
set, or aliased routes). The server can't be the authority here without rendering
the shell on every soft-nav, which is exactly the cost segment-scoping removes. So
the exact-or-ancestor heuristic is the default, and the planned escape hatch for
the minority that needs a different rule is **declarative, per-link** — a marker
like `data-june-active="exact"` or `data-june-active="/guide/*"` the hook honors —
rather than server-emitted active state. Not yet built; the default covers the
common docs/nav convention.

## Minimal path to segment-scoped fragments

When a large nested-layout surface justifies it:

1. **Declare the boundary.** Let a layout mark where the persistent shell ends
   and the swap region begins — a `<JuneOutlet>` slot (or a `data-june-root` the
   layout places itself) — instead of `document.tsx` wrapping the whole children
   (`document.tsx`, `<div data-june-root>{children}</div>`).
2. **Render only the segment.** `renderFragment` (`pipeline.ts`) renders the leaf
   plus the layouts *inside* the boundary, not the full `chain.reduceRight`. The
   persistent shell is excluded from the payload.
3. **Move the highlight.** The router (`client-router.ts`) fires a post-nav hook
   that sets `aria-current` from `location.pathname`, since the shell is no
   longer re-rendered.

Parity still gates it: a segment-scoped fragment morphed into a live page must
yield the same content-region DOM as a full load of that URL (minus
preserved-island state) — the same contract `runtime-convergence.md` asserts for
the whole-chain fragment.

## Decision guide

- **Content site, sidebar fits the viewport (sticky, no inner scroll):** Tier 0.
  Done — free highlight, free transitions, zero JS.
- **Docs site, long internally-scrolled sidebar:** Tier 0 + a ~10-line
  scroll-restore script, OR Tier 1 if you also want the rest of the state model.
- **App-like surface (dashboard, builder, live connection):** Tier 1, with
  `<Island persist>` on the live nodes.
- **Large nested-layout app where the shell is expensive to re-walk:** Tier 1 +
  segment-scoped fragment (when built).
- **A route that needs streamed, fine-grained reconcile:** Tier 2 (Flight),
  opt-in, per route.
