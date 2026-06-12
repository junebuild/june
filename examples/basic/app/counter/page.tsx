import { route } from "@junejs/core/route";
import { Island } from "@junejs/core/islands";

import { Counter } from "../Counter";

// The islands fixture route: the page itself is server-rendered (and still
// answers as .md/.json like any route); only the <Island> subtree hydrates.
export default route({
  load: () => ({}),
  view: () => (
    <main>
      <h1>Counter</h1>
      <p>The button below is a client island — the rest of this page ships no JS.</p>
      <Island name="Counter" component={Counter} props={{ initial: 0 }} />
    </main>
  ),
  metadata: { title: "Counter" },
});
