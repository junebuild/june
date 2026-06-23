import { Counter } from "./Counter";

// The islands route: no loader → a static page; only the <Counter> subtree
// hydrates, the rest ships no JS. Still answers as .md/.json.
export default function CounterPage() {
  return (
    <main>
      <h1>Counter</h1>
      <p>The button below is a client island — the rest of this page ships no JS.</p>
      <Counter initial={0} />
    </main>
  );
}

export const metadata = { title: "Counter" };
