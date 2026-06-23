import { Panel } from "./Panel";
import { Counter } from "../counter/Counter";

// The Panel chrome is interactive (a client island). Everything it WRAPS is
// server-rendered — the paragraph ships no JS, and the nested <Counter> is its own
// island that hydrates independently inside the slot.
export default function SlotPage() {
  return (
    <main>
      <h1>Slot island</h1>
      <p>An interactive shell wrapping zero-JS server content (plus a nested island).</p>
      <Panel client:load>
        <article>
          <p>This paragraph is plain server HTML — no client JS.</p>
          <Counter initial={0} client:load />
        </article>
      </Panel>
    </main>
  );
}

export const metadata = { title: "Slot" };
