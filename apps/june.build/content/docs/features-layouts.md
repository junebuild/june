---
title: "Layouts: nested, composed, frozen"
nav: "Layouts"
description: layout.tsx wraps its segment and everything below; chains compose root → leaf, and the build freezes the same chain dev resolves.
date: 2026-06-12
section: Features
order: "7"
---
## The feature

A `layout.tsx` anywhere in `app/` wraps its segment and everything beneath
it. Chains compose outside-in, root → leaf:

```
app/layout.tsx            ← nav + footer, on every page
└── app/docs/layout.tsx   ← the docs sidebar, on every /docs/* page
    └── app/docs/[slug]/page.tsx
```

A layout is a plain server component — `({ children }) => JSX` — with no
registration step: its presence in the directory is the wiring.

```tsx
// app/docs/layout.tsx (this site's actual sidebar)
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout="docs">
      <nav>{/* sections + short labels */}</nav>
      <div>{children}</div>
    </div>
  );
}
```

## Frozen, not re-derived

`june build` freezes each route's layout chain into the worker manifest —
the deployed worker composes the exact chain dev resolved from the
filesystem. Our parity suite asserts the result byte-for-byte, which is how
a layout bug stays a bug you see in dev rather than one you meet in
production.

## See it on this page

You are inside two layouts right now: the root layout (the nav above, the
footer below) and the docs layout (the sidebar). The blog renders through
the same root layout with no docs sidebar — same mechanism, different
subtree. Zero client JavaScript is involved in any of it.

## Why it matters

Shared chrome is the classic source of duplication (and of agent-written
pages that forget the wrapper). A layout that attaches by location makes
the right structure the path of least resistance — for both kinds of
authors.
