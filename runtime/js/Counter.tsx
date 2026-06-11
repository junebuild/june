import { useState } from "react";

// SSR-only for this runtime PoC (we measure server render, not hydration).
export function Counter({ initial = 0 }: { initial?: number }) {
  const [n] = useState(initial);
  return <button type="button">count: {n}</button>;
}
