import { Island } from "@junejs/core/islands";

import { Counter } from "../Counter";

// The islands fixture route: no loader → a static page; only the <Island>
// subtree hydrates, the rest ships no JS. Still answers as .md/.json.
export default function CounterPage() {
  return (
    <main>
      <h1>Counter</h1>
      <p>The button below is a client island — the rest of this page ships no JS.</p>
      <Island name="Counter" component={Counter} props={{ initial: 0 }} />
    </main>
  );
}

export const metadata = { title: "Counter" };
