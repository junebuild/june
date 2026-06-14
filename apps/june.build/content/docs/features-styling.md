---
title: "Styling: global CSS, Tailwind, CSS Modules"
nav: "Styling"
description: app/global.css is auto-linked (no import); Tailwind v4 is the blessed default; *.module.css scopes deterministically. Dev serves readable CSS with HMR, build ships hashed, immutable, minified.
date: 2026-06-13
section: Features
order: "8.5"
---
## The feature

Styling is convention, not configuration. Drop `app/global.css` and June links
it on every page — no `import "./global.css"`, no `<link>` to wire:

```css
/* app/global.css — auto-linked, recompiled on save, shipped as a static asset */
body { font-family: system-ui; }
```

Plain CSS works with zero dependencies. That's the floor; the rest is opt-in.

## Tailwind v4 (the blessed default)

Opt into Tailwind by importing it from `global.css` — June compiles it through
the app's **own** Tailwind v4 (resolved from your `node_modules`, never bundled
into the framework), so you control the version and Tailwind auto-detects the
classes it needs:

```css
/* app/global.css */
@import "tailwindcss";
```

The starter ships this line and Tailwind-styled pages. Plain CSS and Tailwind
coexist in the same file.

## CSS Modules

Name a file `*.module.css` and `import` it for locally-scoped class names:

```css
/* app/Card.module.css */
.card { padding: 1rem; border: 1px solid #ddd }
.title { font-weight: 600 }
```

```tsx
import styles from "./Card.module.css";

export default function Card() {
  return <div className={styles.card}><h2 className={styles.title}>…</h2></div>;
}
```

`styles.card` resolves to a scoped name like `card_9e43e788`. The scoped name is
a **deterministic hash** of the file path + class — *not* a bundler-internal
counter — so the name is byte-identical in dev SSR, the production worker build,
the client islands bundle, and whether you run on Bun or Node. That identity is
what makes hydration safe: the server and client always agree on the class.

The full CSS-Modules surface works:

```css
.btn { composes: base from "./shared.module.css"; color: white }
:global(.prose a) { text-decoration: underline }
```

- **`composes`** pulls in another local (even across files); `styles.btn`
  becomes the merged `"btn_… base_…"`.
- **`:global(...)`** opts a selector out of scoping for genuinely global rules.

For app-wide globals, prefer `app/global.css`; reach for `:global` only inside a
module.

## What the build ships

Dev serves CSS readable and hot — edit a stylesheet and the page swaps it
without a reload. `june build` optimizes it:

- every stylesheet is **content-hashed** and emitted under the reserved
  `/_june/` prefix (e.g. `/_june/global.a1b2c3d4.css`), so it can be served
  **immutable** — the browser never revalidates it, and a change ships a new
  filename;
- output is **minified** with Lightning CSS (the same engine Tailwind v4
  optimizes with), so global CSS, Tailwind, and CSS-Modules sheets all come out
  consistently small.

The `/_june/` prefix is June's alone — your routes and your own asset paths can
never collide with framework output.

## Why it matters

CSS is the one surface that is purely for humans — it never touches the agent
projections (`.md` / `.json` / `/mcp`). So the rule is "stay out of the way":
the floor is plain CSS with no build to think about, the ceiling is Tailwind +
scoped modules with deterministic names an agent can reason about, and the
dev↔build difference is only the asset URL — never the rendered markup, which is
what keeps the dual-audience parity contract intact.
