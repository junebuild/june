"use client";
// PoC island used DIRECTLY as <Counter/>. The inner function is named `Counter`
// to MATCH the export, so its runtime island name == the export name the auto
// registry keys by — no explicit { name }, no hand-written loader map.
import { useState } from "react";

import { island } from "@junejs/core/islands";

export const Counter = island(function Counter({
  initial = 0,
  label = "count",
}: {
  initial?: number;
  label?: string;
}) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      {label}: {n}
    </button>
  );
}, { strategy: "load" });
