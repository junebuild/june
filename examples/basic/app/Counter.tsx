"use client";
// The fixture island: a `"use client"` component with state + a click handler.
// Server-rendered it is inert markup; hydration (via app/_client.tsx) is what
// makes the button count — the v0.1 islands acceptance criterion.
import { useState } from "react";

export function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
