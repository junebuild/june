"use client";
// The example island (island v2): used directly as <Counter/>. The server renders
// it inert ("count: 0"); the client entry hydrates it so the button counts.
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
