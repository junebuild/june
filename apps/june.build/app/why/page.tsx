import { route } from "@junejs/core/route";

import { bySlug } from "../content";

const page = bySlug("why")!;

export default route({
  prerender: true,
  metadata: { title: "Why June", description: page.summary },
  view: () => (
    <main>
      <h1>Why June</h1>
      <h2>The bet</h2>
      <p>
        Software now has two audiences — people and agents — and two authors: people and agents.
        June is designed for that world end to end.
      </p>
      <ul style={{ lineHeight: 1.8 }}>
        <li>
          <strong>Serving agents:</strong> one <code>route()</code> = HTML + JSON + markdown +
          capability manifest. llms.txt, sitemap, MCP derive automatically. Tools are
          intent-shaped, policy-checked — never auto-CRUD.
        </li>
        <li>
          <strong>Agents as principals:</strong> an agent calling <code>/mcp</code> carries a
          user&apos;s credential and hits the SAME authorization check the UI does —{" "}
          <code>defineAction.run(input, ctx)</code> is one gate for both.
        </li>
        <li>
          <strong>Built by agents:</strong> conventions a coding agent can&apos;t misread, plain
          SQL migrations, scaffolds that ship an AGENTS.md, and an oracle for every artifact.
        </li>
      </ul>
      <h2>The wedge</h2>
      <p>
        No glue layer. Declare <code>auth</code>, <code>resources</code>, and your actions in one
        model; June wires the adapter, mounts the endpoints, and bridges identity into the agent
        surface.
      </p>
      <h2>The honest part</h2>
      <p>
        Pre-1.0. Benchmarks are dev-machine numbers with published methodology. The owned Rust+V8
        runtime and server-reactive live RSC are experimental roadmap items — today&apos;s host is
        Bun/Node, deploying to Workers.
      </p>
    </main>
  ),
  md: () => page.md,
  json: () => ({ title: page.title, summary: page.summary }),
});
