# Styling — Tailwind v4 + shadcn, build-integrated (v0.1 constraint)

> Decided 2026-06-11. June blesses **Tailwind v4** (+ **shadcn/ui**) as the default
> styling stack and integrates it at BUILD time — never the CDN. Same philosophy
> as auth (Better Auth) and data (Juno): opinionated default, zero glue, open
> seam. See docs/auth-integration.md, docs/data-layer-boundary.md.

## Why not the Tailwind CDN (Play CDN / in-browser JIT)

It is the wrong default even for v0.1. Tailwind itself labels it "not for
production", and every reason it gives contradicts June's pitch:

1. It ships a few-hundred-KB **browser-side CSS compiler** that scans the DOM and
   compiles CSS at runtime — antithetical to "fast / edge / owned runtime / less JS".
2. **FOUC** (flash of unstyled content) on SSR — ugly for an SSR/MPA framework.
3. No real purge; runtime cost on every page.

The CDN is acceptable ONLY as a documented "30-second playground" escape, never
the framework default and never the dogfood site (which must prove June is fast).

## The blessed stack

- **Tailwind v4** — Oxide engine (Rust, fast), CSS-first config (`@import
  "tailwindcss"`, no config file needed for basics), and a **standalone binary**
  (the CSS step needs no node_modules — aligns with June's single-binary direction).
- **shadcn/ui** — copy-IN components (you own the source, not a dependency), built
  on Tailwind + Radix. The "components are yours" model fits June's
  opinionated-but-yours philosophy exactly.

## Build-stage integration (how it plugs into June)

June already owns the build (Rolldown) + assets dir + prerender; styling adds one
CSS step:

- **`june build`**: run the Tailwind v4 engine over the app source → emit ONE
  hashed static CSS asset → the Document `<link>`s it → the assets layer serves it
  at 0ms, cached. Zero client JS, purged, tiny.
- **`june dev`**: watch the source + input CSS, regenerate, and **CSS-HMR** (swap
  the stylesheet, no full reload — simpler than JS HMR).
- **create-june** ships this wired: open the box, you have styling.
- The Document keeps a minimal base stylesheet as a fallback for apps that opt out
  of Tailwind.

## shadcn ↔ islands: two separable layers

- **Static styling (Tailwind classes) works today** — pure CSS, zero JS, ideal for
  SSR/MPA. v0.1 "basic styling" is available as soon as the build CSS step lands.
- **shadcn's INTERACTIVE components** (dropdown, dialog, … via Radix) need client
  JS, so they ride on the v0.1 "minimal client islands" must-have
  (docs: the v0.1 milestone). Styling and interactivity do not block each other:
  Tailwind styling comes with the build step; interactive shadcn components come
  with islands.

## The seam stays open

Tailwind is the blessed default, not mandatory. Plain CSS, CSS Modules, and
inline `<style>` keep working; the Document's base stylesheet covers the
no-Tailwind path. Same shape as Juno (default ORM, Drizzle/Prisma first-class) and
Better Auth (blessed, others over the same resources).

## Future alignment

Tailwind v4's Oxide engine is Rust. As the native runtime's transpile/asset funnel
matures, the CSS step can move in-process — "one binary that even bundles CSS".
v0.1 just shells out to the standalone Tailwind CLI; no need to do this now.

## v0.1 scope

- Tailwind v4 build integration + create-june default = the styling story.
- Framework ships a minimal base stylesheet as the opt-out fallback.
- The CDN appears only in the README as a "quick playground" note, never default.
