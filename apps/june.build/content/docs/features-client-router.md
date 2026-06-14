---
title: "Client Router: the opt-in SPA layer"
nav: "Client Router"
description: Off by default — turn it on for app-like surfaces that need in-memory state to survive navigation. Soft swaps over the same HTML the server already serves, with <Island persist> for websockets.
date: 2026-06-14
section: Features
order: "9.5"
---
## The feature

[Navigation](/docs/features-navigation) is the floor: the browser navigates,
June ships no router. But some surfaces — a dashboard, a builder, anything
with a live connection — need in-memory state to *survive* a navigation, not
reset on every click. For those, flip one switch:

```ts
// june.config.ts
export default defineJune({ clientRouter: true });
```

Now same-origin link clicks become **soft swaps**: June fetches the next page
— the *same* complete HTML document the server already serves, no special
payload format — replaces the page region, re-hydrates that page's
[islands](/docs/features-islands), and animates the swap with View
Transitions. History (`pushState`/back-forward) just works. There is no
client route table and no [Flight payload](/docs/features-rsc): the
full-HTML-per-URL contract *is* the navigation transport.

## Persist a live island

Because June composes layouts into the page itself, a normal swap would tear
down everything — including an open websocket. Mark an island `persist` and
the router carries its **live node** (React state, open connections and all)
across the navigation instead of re-creating it:

```tsx
// app/dashboard/layout.tsx
import { Island } from "@junejs/core/islands";
import { LiveFeed } from "./LiveFeed";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Island name="LiveFeed" component={LiveFeed} persist />  {/* socket stays open */}
      {children}
    </>
  );
}
```

## Pure progressive enhancement

The router only ever *adds* behavior on top of pages that already work:

- **It degrades.** No JS, a failed fetch, or a response it doesn't recognize
  all fall back to a normal browser navigation — never a broken page.
- **It's race-safe.** A navigation-generation token discards a stale response
  when a newer navigation overtakes it (the classic click-then-back bug).
- **The agent surface is untouched.** Every URL is still a complete,
  projectable document — `.md`, `.json`, and `/mcp`
  ([MCP](/docs/features-mcp)) are exactly what they were. The router lives
  only on the human surface.

Off by default. This very site keeps it off — it's documents, so the browser
navigates and we ship [~1KB of rules, no router](/docs/features-navigation).

## Why it matters

The real question was never "does June have an SPA mode" — it's "do you want
to carry a client router." For most sites the answer is no, and the
[Standards](/docs/features-web-standards) floor already feels instant. For
the app-like minority that needs state to outlive a navigation, the router is
there as one config line — and even then it's an enhancement you can remove,
not a runtime your whole site now depends on.
