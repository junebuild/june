"use client";
// A stand-in for a stateful, connection-holding island (think an open websocket).
// Rendered with `persist` in the layout, so the client router carries this LIVE
// node across navigations instead of tearing it down. The click count is the
// tell: a freshly re-created island would reset to 0, a carried one keeps its
// state. Deterministic SSR (starts at 0) — no hydration mismatch.
import { useState } from "react";

export function Live() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-live onClick={() => setN((v) => v + 1)}>
      pings: {n}
    </button>
  );
}
