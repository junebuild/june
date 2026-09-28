---
title: Why June
description: Agents are becoming half your traffic and most of your code authors. Frameworks that only render pixels are answering yesterday's question.
---
## Vision

Software now has two audiences — people and agents — and two authors: people
and agents. June is designed for that world end to end:

- **Agents inside your app**: an agent is a feature, not a separate runtime.
  An `agent/` directory makes the actions you export into it its tools, Slack,
  Crisp, or HTTP its channels, and remote MCP servers, OpenAPI specs, or
  Google Drive its connections — and every turn is durable: checkpointed,
  able to park for a human's approval and pick back up.
- **Serving agents**: routes are projections. One `route()` = HTML view +
  JSON + markdown. llms.txt, sitemap, and an MCP endpoint derive
  automatically. Tools are intent-shaped, policy-checked — never auto-CRUD.
- **Agents as principals**: an agent calling `/mcp` carries a user's
  credential and hits the SAME authorization check the UI does —
  `defineAction.run(input, ctx)` is one gate for both.
- **Built by agents**: conventions a coding agent can't misread — file-system
  routing, plain SQL migrations (the SQL you read is the SQL that runs), and
  an oracle for every artifact.

## Core design philosophy

No glue layer. Declare `auth`, `resources`, and your actions in one model;
June wires the adapter, mounts the endpoints, and bridges identity into the
agent surface. The framework's job is to make "an agent can safely operate my
app" a default, not a weekend of adapter code.

June is opinionated on purpose — these choices are made for you:

- **Convention over configuration.** Presence is the API: a `page.tsx` is a
  route, an `app/_client.tsx` enables hydration, an `agent/` directory is an
  agent, a `content/*.md` joins the manifest. Nothing asks to be wired.
- **Don't repeat yourself.** One `route()` is four surfaces; one
  `defineAction()` is a UI action, an MCP tool, and a browser WebMCP tool — and
  your agent's tool once you export it from `agent/tools/`; one render core
  serves dev and prod. Nothing drifts because nothing is duplicated — even our
  benchmark numbers render from a single registry, and this page is one file.
- **Defaults you remove, not assemble.** The agent surface ships ON;
  `june.config.ts` exists to turn things off. An undeclared resource doesn't
  exist; an unused one compiles away.
- **Blessed picks over option matrices.** One recommended auth, one default
  data layer — each swappable, none left as homework.
- **Zero client JS until a subtree earns it.** Interactivity is an explicit
  island, and navigation belongs to the browser (Speculation Rules, View
  Transitions). A client router is opt-in, for when state must outlive a
  navigation.
- **The SQL you read is the SQL that runs.** Plain SQL migrations — no DSL
  for a human or an agent to misread.
- **Markdown is source, not output.** The `.md` surface serves your authored
  bytes; nothing is reconstructed from rendered HTML.

## Where we are

June is 0.0.x — the spec is still being drafted, and APIs will change. Routes,
projections, actions, and MCP are stable; the agent layer, the data layer, and
auth are still changing. Benchmarks are dev-machine numbers with published
methodology. The owned Rust+V8 runtime and server-reactive live RSC are
experimental — today's host is Bun/Node, deploying to Cloudflare Workers,
Vercel, or Deno Deploy, or exporting a static site. Each piece's standing is
on the [stability & roadmap](/docs/05-stability) page.
