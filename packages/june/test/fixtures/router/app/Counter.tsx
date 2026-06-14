"use client";
// Per-page island: state + a click handler. SSR'd inert, hydrated on each page.
// Its `initial` prop differs per route so the test can tell a freshly-hydrated
// page apart from a carried-over one.
import { useState } from "react";

export function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
