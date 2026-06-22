import { Tab } from "@junejs/core/poc-islands";

import { Counter } from "./Counter";
import { Tabs } from "./Tabs";

// PoC route: the target authoring surface — components used by name, with the
// hydration intent declared right at the call site (Astro-style), plus a
// server-slot <Tabs>. Still SSRs to zero-JS-visible HTML; still answers .md/.json.
export default function PocPage() {
  return (
    <main>
      <h1>PoC · intent-based islands</h1>
      <p>Open the console and the network/perf panel — each island wakes up on its own intent.</p>

      <section>
        <h2>
          <code>load</code> — hydrates immediately
        </h2>
        <Counter initial={0} label="load" />
      </section>

      <section>
        <h2>
          <code>idle</code> — hydrates in requestIdleCallback
        </h2>
        <Counter initial={100} label="idle" client:idle />
      </section>

      <section>
        <h2>
          <code>only</code> — never SSR'd, mounts fresh on the client
        </h2>
        <Counter initial={7} label="client-only" client:only />
      </section>

      <section>
        <h2>
          Server-slot <code>&lt;Tabs&gt;</code>
        </h2>
        <Tabs>
          <Tab title="Overview">
            <p>This panel is server-rendered content handed to a client shell.</p>
          </Tab>
          <Tab title="Details">
            <ul>
              <li>The shell (tab buttons) is interactive.</li>
              <li>The panels came from the server as a light-DOM slot.</li>
            </ul>
          </Tab>
        </Tabs>
      </section>

      <section style={{ marginTop: "130vh" }}>
        <h2>
          <code>visible</code> — hydrates on scroll into view
        </h2>
        <Counter initial={0} label="visible" client:visible />
      </section>
    </main>
  );
}

export const metadata = { title: "PoC islands" };
