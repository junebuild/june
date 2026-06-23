import { Counter } from "./Counter";

// Only the <Counter> subtree hydrates (client:load); the rest ships no JS.
export default function CounterPage() {
  return (
    <main>
      <h1>Counter</h1>
      <p>The button below is a client island — the rest of this page ships no JS.</p>
      <Counter initial={0} client:load />
    </main>
  );
}

export const metadata = { title: "Counter" };
