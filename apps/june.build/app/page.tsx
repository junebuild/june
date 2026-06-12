import { route } from "@junejs/core/route";

import { bySlug } from "./content";
// Side-effect import: registers search_site / get_page so warmup surfaces them
// at /mcp (warmup loads route files; standalone modules must be reachable).
import "./actions";

const page = bySlug("index")!;

export default route({
  prerender: true,
  metadata: { title: page.title, description: page.summary },
  view: () => (
    <main>
      <h1 style={{ fontSize: 38, marginBottom: 4 }}>June</h1>
      <p style={{ fontSize: 19, color: "#444" }}>{page.summary}</p>
      <ul style={{ lineHeight: 1.9 }}>
        <li>
          <strong>One definition, five surfaces</strong> — this site speaks HTML to you and
          markdown / JSON / MCP to agents. Try <code>/why.md</code>, <code>/benchmarks.json</code>,
          or point an MCP client at <code>/mcp</code>.
        </li>
        <li>
          <strong>No glue layer</strong> — auth, data, and agent capabilities are one model;
          you wire no adapter matrix.
        </li>
        <li>
          <strong>Agents as scoped users</strong> — an agent calling <code>/mcp</code> hits the
          same authorization check the UI does.
        </li>
        <li>
          <strong>Data magic</strong> — writes auto-invalidate the cache; component reads
          auto-batch. Zero manual <code>revalidate()</code>.
        </li>
      </ul>
      <p>
        <a href="/why">Why June →</a> · <a href="/docs">Docs →</a> · <a href="/benchmarks">Benchmarks →</a>
      </p>
    </main>
  ),
  md: () => page.md,
  json: () => ({ title: page.title, summary: page.summary }),
});
