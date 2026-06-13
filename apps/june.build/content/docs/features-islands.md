---
title: "Islands: zero client JS by default"
nav: "Islands"
description: Pages ship no JavaScript unless a subtree opts in — one <Island> hydrates against an explicit registry while the rest stays server-rendered HTML.
date: 2026-06-12
section: Features
order: "8"
---
## The feature

June pages are server-rendered and ship **zero client JavaScript** — this
site's pages, including the one you're reading, send none. Interactivity is
opt-in per subtree:

```tsx
// app/page.tsx — server component (the default export IS the view)
import { Island } from "@junejs/core/islands";

export default function Page() {
  return (
    <main>
      <h1>Mostly static</h1>
      <Island name="Counter" props={{ start: 0 }} />  {/* the ONE live subtree */}
    </main>
  );
}
```

```ts
// app/_client.ts — the explicit registry; its presence is what enables /client.js
import { hydrateIslands } from "@junejs/core/islands-client";
import { Counter } from "./Counter";

hydrateIslands({ Counter });
```

`<Island>` server-renders a marker carrying the registry name + JSON props;
`hydrateIslands()` scans the page and `hydrateRoot()`s each marker. No
`app/_client.*` file → no bundle, no script tag, output unchanged.

## Try it

```bash
npm create june my-app    # the starter ships a working Counter island
```

The starter's counter — and the framework's own e2e test — run the REAL
production bundle a `june build` ships against the built worker's SSR markup:
what's tested is what deploys.

## Why it matters

Hover-prerendering and View Transitions already make navigation feel
instant with no client code ([Navigation](/docs/features-navigation)).
Islands keep the budget at zero until a specific subtree earns it.
