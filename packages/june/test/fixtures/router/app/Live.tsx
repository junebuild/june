"use client";
// A stateful, connection-holding island. `persist` makes the client router carry
// this LIVE node across navigations instead of tearing it down; the click count
// is the tell (a re-created island resets to 0, a carried one keeps its state).
import { useState } from "react";

import { island } from "@junejs/core/islands";

export const Live = island(
  function Live() {
    const [n, setN] = useState(0);
    return (
      <button type="button" data-live onClick={() => setN((v) => v + 1)}>
        pings: {n}
      </button>
    );
  },
  { persist: true },
);
