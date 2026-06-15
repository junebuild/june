---
title: "Live updates: a connection that survives navigation"
nav: "Live updates"
description: Put a server-push connection (SSE or WebSocket) inside a persist island — it keeps streaming across soft navigations instead of reconnecting on every click. Plus what to know about connection limits when you deploy.
date: 2026-06-15
section: Features
order: "9.6"
---
## The feature

A live surface — a dashboard, a token stream, a build log, tool-call status —
needs a connection that **outlives the page it started on**. The
[Client Router](/docs/features-client-router) gives you the seam: open your
connection inside an [island](/docs/features-islands), mark it `persist`, and
June carries that live node — React state, open socket and all — across a soft
navigation instead of tearing it down and reconnecting.

```tsx
// app/StatusFeed.tsx — an island that owns its own connection
import { useEffect, useState } from "react";

export function StatusFeed() {
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/status");           // server push (SSE)
    es.onmessage = (e) => setEvents((prev) => [e.data, ...prev].slice(0, 50));
    return () => es.close();
  }, []);

  return (
    <ul>
      {events.map((line, i) => <li key={i}>{line}</li>)}
    </ul>
  );
}
```

```tsx
// app/dashboard/layout.tsx — persist it so it survives navigation
import { Island } from "@junejs/core/islands";
import { StatusFeed } from "../StatusFeed";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Island name="StatusFeed" component={StatusFeed} persist />
      {children}
    </>
  );
}
```

Click between pages inside the dashboard and the feed keeps streaming — no flash,
no dropped connection, no re-subscribe. Without `persist`, every navigation would
restart the `EventSource` from scratch.

## SSE or WebSocket — pick by direction

The island owns the transport, so use whichever fits:

- **Server-Sent Events** (`EventSource`) for one-way server→client streams (live
  logs, notifications, AI token streams). It has **built-in auto-reconnect** and
  resumes with `Last-Event-ID` — the least code for the most common case.
- **WebSocket** when the client also talks back (chat, collaborative editing,
  interactive control planes).

Either way the page stays a complete, projectable document — `.md`, `.json`, and
[`/mcp`](/docs/features-mcp) are untouched. Live updates live only on the human
surface; the agent surface still gets the same clean snapshot.

## Deploying a connection: what to know

A held-open connection behaves differently from a request/response route, and the
limits depend on where you deploy:

- **A single connection is capped (~5 minutes by default on most hosts).** This is
  normal — design for it. SSE's auto-reconnect handles it for free; for WebSocket,
  reconnect on close. Treat a drop as routine, not an error.
- **An open connection bills for the time it's held**, even while idle — it's
  occupancy, not CPU (waiting is free). Push only when data actually changes, and
  the connection stays cheap. On **Cloudflare**, long-lived connections belong in a
  **Durable Object** (with WebSocket Hibernation, an idle connection costs nothing);
  on **Vercel**, a function streams up to its `maxDuration` then reconnects.
- **Offer a fallback.** If a connection can't be established (a strict proxy, an old
  client), poll the same endpoint on an interval. The UI code doesn't care how the
  next update arrived.

## You only pay for the pages that want it

Live updates are inherently opt-in: a page with no connection island is still
[zero-JS](/docs/features-web-standards) and costs nothing extra. The streaming
surfaces are exactly the ones you marked — everything else stays a plain, fast,
cacheable document. Add a connection where the experience needs one, not site-wide.

## Why it matters

Most frameworks make you choose between "instant document" and "live app" at the
project level. June lets you keep the document floor everywhere and add a surviving
connection precisely where a surface earns it — one island, one `persist`, your own
transport. The hard part (keeping the live node alive across navigation) is the
framework's job; the connection itself stays plain web-standard code you fully
control.

## See it live

The [Cake Site demo](https://june-cake.vercel.app/recipes/chocolate-cake) runs this
exact pattern on Vercel's edge: a 🔴 live feed in the header opens an `EventSource`
to `/api/activity` from inside a `persist` island. Click between the two recipes and
watch the event count keep climbing — the connection streams straight through the
navigation instead of reconnecting. Source:
[junebuild/cake](https://github.com/junebuild/cake) ([`StatusFeed.tsx`](https://github.com/junebuild/cake/blob/main/app/StatusFeed.tsx),
[`_extra.tsx`](https://github.com/junebuild/cake/blob/main/app/_extra.tsx)).
