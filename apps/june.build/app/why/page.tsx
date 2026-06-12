import { route } from "@junejs/core/route";

import { bySlug } from "../content";

const page = bySlug("why")!;

export default route({
  prerender: true,
  metadata: { title: "Why June", description: page.summary },
  view: () => (
    <main>
      <h1>Why June</h1>
      <h2>Vision</h2>
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
          SQL migrations, and an oracle for every artifact.
        </li>
      </ul>
      <h2>Core design philosophy</h2>
      <p>
        No glue layer. Declare <code>auth</code>, <code>resources</code>, and your actions in one
        model; June wires the adapter, mounts the endpoints, and bridges identity into the agent
        surface. June is opinionated on purpose — these choices are made for you:
      </p>
      <ul style={{ lineHeight: 1.8 }}>
        <li>
          <strong>Convention over configuration.</strong> Presence is the API: a{" "}
          <code>page.tsx</code> is a route, an <code>app/_client.ts</code> enables hydration, a{" "}
          <code>content/*.md</code> joins the manifest. Nothing asks to be wired.
        </li>
        <li>
          <strong>Don&apos;t repeat yourself.</strong> One <code>route()</code> is five surfaces;
          one <code>defineAction()</code> is a UI action, an MCP tool, and a manifest entry; one
          render core serves dev and prod. Nothing drifts because nothing is duplicated — even
          our benchmark numbers render from a single registry.
        </li>
        <li>
          <strong>Defaults you remove, not assemble.</strong> The agent surface ships ON;{" "}
          <code>june.config.ts</code> exists to turn things off. An undeclared resource
          doesn&apos;t exist; an unused one compiles away.
        </li>
        <li>
          <strong>Blessed picks over option matrices.</strong> One recommended auth, one default
          data layer — each swappable, none left as homework.
        </li>
        <li>
          <strong>Zero client JS until a subtree earns it.</strong> Interactivity is an explicit
          island; navigation belongs to the browser (Speculation Rules, View Transitions), not a
          client router.
        </li>
        <li>
          <strong>The SQL you read is the SQL that runs.</strong> Plain SQL migrations — no DSL
          for a human or an agent to misread.
        </li>
        <li>
          <strong>Markdown is source, not output.</strong> The <code>.md</code> surface serves
          your authored bytes; nothing is reconstructed from rendered HTML.
        </li>
      </ul>
      <h2>Where we are</h2>
      <p>
        June is 0.0.x — the spec is still being drafted, and APIs will change. Benchmarks are
        dev-machine numbers with published methodology. The owned Rust+V8
        runtime and server-reactive live RSC are experimental roadmap items — today&apos;s host is
        Bun/Node, deploying to Workers.
      </p>
    </main>
  ),
  md: () => page.md,
  json: () => ({ title: page.title, summary: page.summary }),
});
