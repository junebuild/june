"use client";
import { useState } from "react";
export function Live() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-live onClick={() => setN((v) => v + 1)}>
      pings: {n}
    </button>
  );
}
