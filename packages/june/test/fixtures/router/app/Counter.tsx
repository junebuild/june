"use client";
// Per-page island (island v2). `initial` differs per route so the test can tell a
// freshly-hydrated page apart from a carried-over one.
import { useState } from "react";

import { island } from "@junejs/core/islands";

export const Counter = island(function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
});
