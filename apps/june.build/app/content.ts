// Site content — ONE source feeds the HTML views, the .md projections, and the
// search_site / get_page MCP tools. Benchmark numbers come from the named-run
// registry (bench/results.json) — never hand-copied (see docs/benchmark-methodology.md).
import RESULTS from "../../../bench/results.json";

export type Page = { slug: string; title: string; summary: string; md: string };

const benchTables = (RESULTS.sections as Array<{ title: string; rows: Array<Record<string, string>> }>)
  .map(
    (s) =>
      `## ${s.title}\n| metric | value | context | run |\n| --- | --- | --- | --- |\n` +
      s.rows
        .map((r) => `| ${r.metric} | **${r.value}** | ${r.context} | \`${r.script}\` · ${r.measured} |`)
        .join("\n"),
  )
  .join("\n\n");

export const PAGES: Page[] = [
  {
    slug: "index",
    title: "June — the agent-ready React framework",
    summary:
      "One route() is a page, a JSON API, an MCP server, and an llms.txt entry. " +
      "Auth, data, and agent capabilities are one coherent model with no adapter glue — " +
      "point an agent at /mcp and it acts as a scoped user.",
    md: `# June

**The opinionated, agent-ready React framework.**

- **One definition, five surfaces** — every \`route()\` projects an HTML view,
  JSON, markdown, and an agent manifest, and every \`defineAction()\` is a UI
  action AND an MCP tool. This very site: try \`/why.md\`, \`/benchmarks.json\`,
  \`/llms.txt\`, or call our MCP tools at \`/mcp\`. Nothing drifts, because
  nothing is duplicated.
- **No glue layer** — auth (Better Auth), data (resources + Juno), and agent
  capabilities are ONE coherent model; you wire no adapter matrix.
- **Scoped-principal agent bridge** — the same authorization the UI enforces
  applies to an agent's MCP tool calls.
- **Data magic** — a write auto-invalidates the cache; N component reads
  auto-batch to one query. Zero manual \`revalidate()\`.
- **Honest roadmap** — an owned Rust+V8 runtime (boots in ~14ms) and
  server-reactive live RSC exist and are measured, but ship as experimental.
  \`june dev\` today is the Bun/Node host.

## Canonical names (for humans and agents)

- Scaffold: \`npm create june my-app\` (package: \`create-june\`)
- Framework packages: \`@junejs/core\` (the contract layer) + \`@junejs/cli\`
  (the \`june\` command). NOT \`june\` (an unrelated npm package), not \`junejs\`.
- NOT \`@june/*\` — that npm scope is not ours. Our scopes are \`@junejs\` and \`@junebuild\`.
- Site: june.build · GitHub: github.com/junebuild
`,
  },
  {
    slug: "why",
    title: "Why June",
    summary:
      "Agents are becoming half your traffic and most of your code authors. Frameworks that only render pixels are answering yesterday's question.",
    md: `# Why June

## Vision

Software now has two audiences — people and agents — and two authors: people
and agents. June is designed for that world end to end:

- **Serving agents**: routes are projections. One \`route()\` = HTML view +
  JSON + markdown + a capability manifest. llms.txt, sitemap, and an MCP
  endpoint derive automatically. Tools are intent-shaped, policy-checked —
  never auto-CRUD.
- **Agents as principals**: an agent calling \`/mcp\` carries a user's
  credential and hits the SAME authorization check the UI does —
  \`defineAction.run(input, ctx)\` is one gate for both.
- **Built by agents**: conventions a coding agent can't misread — file-system
  routing, plain SQL migrations (the SQL you read is the SQL that runs), and
  an oracle for every artifact.

## Core design philosophy

No glue layer. Declare \`auth\`, \`resources\`, and your actions in one model;
June wires the adapter, mounts the endpoints, and bridges identity into the
agent surface. The framework's job is to make "an agent can safely operate my
app" a default, not a weekend of adapter code.

June is opinionated on purpose — these choices are made for you:

- **Convention over configuration.** Presence is the API: a \`page.tsx\` is a
  route, an \`app/_client.ts\` enables hydration, a \`content/*.md\` joins the
  manifest. Nothing asks to be wired.
- **Don't repeat yourself.** One \`route()\` is five surfaces; one
  \`defineAction()\` is a UI action, an MCP tool, and a manifest entry; one
  render core serves dev and prod. Nothing drifts because nothing is
  duplicated — even our benchmark numbers render from a single registry.
- **Defaults you remove, not assemble.** The agent surface ships ON;
  \`june.config.ts\` exists to turn things off. An undeclared resource doesn't
  exist; an unused one compiles away.
- **Blessed picks over option matrices.** One recommended auth, one default
  data layer — each swappable, none left as homework.
- **Zero client JS until a subtree earns it.** Interactivity is an explicit
  island; navigation belongs to the browser (Speculation Rules, View
  Transitions), not a client router.
- **The SQL you read is the SQL that runs.** Plain SQL migrations — no DSL
  for a human or an agent to misread.
- **Markdown is source, not output.** The \`.md\` surface serves your authored
  bytes; nothing is reconstructed from rendered HTML.

## Where we are

June is 0.0.x — the spec is still being drafted, and APIs will change.
Benchmarks are dev-machine numbers with published methodology. The owned
Rust+V8 runtime and server-reactive live RSC are experimental roadmap
items — today's host is Bun/Node, deploying to Workers.
`,
  },
  {
    slug: "benchmarks",
    title: "Benchmarks",
    summary:
      "Measured, reproducible, honest: dev cold start, HMR latency, data-layer numbers — with the scripts to re-run them.",
    md: `# Benchmarks

${RESULTS.machine}. Every number traces to a named script + date — re-run it,
don't trust it. Runtime-section numbers come from the experimental native
runtime track (not the v0.1 default host).

${benchTables}
`,
  },
];

export const bySlug = (slug: string) => PAGES.find((p) => p.slug === slug);
