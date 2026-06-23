"use client";
// A plain "use client" island — used as <Counter client:load/> (no wrapper).
import { useState } from "react";
export function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
