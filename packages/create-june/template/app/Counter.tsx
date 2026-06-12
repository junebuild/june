"use client";
// A client island: state + a click handler. The server renders it inert; the
// client entry (app/_client.tsx) hydrates it so the button counts. Everything
// NOT inside an <Island> ships zero client JS.
import { useState } from "react";

export function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
