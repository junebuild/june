---
title: "Agents: a feature of your app, not a separate runtime"
nav: "Overview"
description: Drop an agent/ directory into your June app and it becomes a running, durable agent whose tools are the same defineActions your UI and /mcp already use.
date: 2026-09-27
section: Agents
order: "16"
sources: [packages/core/src/agent-config.ts, packages/core/src/agent-models.ts, packages/core/src/agent-runtime.ts, packages/core/src/config.ts, packages/core/src/channels.ts, packages/core/src/connections.ts, packages/june/src/agent-discover.ts, packages/june/src/agent-native.ts, packages/june/src/app.ts, packages/june/src/agent-compile.ts, packages/june/src/build.ts, examples/agent-edge]
---
## The feature

June's agent layer turns a directory into a running conversational agent,
inside the app you already have. You don't need a separate agent server, an SDK wrapper, or a
second tool registry. Put an `agent/` directory in `app/` and the dev server
discovers it, mounts a chat endpoint, and starts serving turns.

```text
app/
  page.tsx
  agent/
    agent.ts           → { name, model?, description?, surfaces? }
    instructions.md    → the system prompt
    tools/*.ts         → each default-exports a defineAction (or an array of them)
    skills/*.md        → procedures the model loads on demand
    channels/*.ts      → inbound edges (HTTP, Slack, Crisp)
    connections/*.ts   → outbound tool sources (MCP, OpenAPI, providers)
```

The directory *is* the manifest. No central registry has to stay in sync with it.

## The mental model

- **The `agent/` directory becomes an assembled agent.** Native discovery
  (`discoverAgent`) and the edge compiler (`june gen` → `_agent.gen.ts`) both
  produce the same raw module and go through one assembly function, so dev and
  production can't disagree about what the directory means.
- **Tools are `defineAction`s.** The same object is a UI server action, an
  `/mcp` tool, a plain-HTTP `POST /api/<id>` endpoint, and an agent tool. The turn's verified identity arrives as
  `ctx.user`, so the authorization you wrote for the UI also covers the agent.
  A `requiresPrincipal: true` action is hidden from anonymous turns.
- **Channels bring messages in.** A channel is pure transport: an HTTP endpoint,
  a signed Slack or Crisp webhook. It maps an inbound message to a session and
  runs a turn. Some channels also give the agent tools, such as `slackChannel`'s
  `slack_read_thread`.
- **Connections reach out.** A connection points at an external MCP server,
  an OpenAPI document, or a provider (Google Drive). Its remote tools join the
  agent's tool list.
- **Turns are durable.** Every model step and tool call is checkpointed to the
  session's store. A sync tool's step commits in one transaction with its
  checkpoint and transcript append — and so do writes it makes through the
  store's own handle, which makes those exactly-once. Any other effect (another
  database, an API call) and every async tool are at-least-once. A tool can park a turn to wait for a human
  (`ctx.requestInput`) and resume it later.
- **Where it runs.** In dev, turns run on the in-process `NativeRuntime`
  (SQLite). On Cloudflare Workers, each session is its own Durable Object, and
  the loop commits to that object's `ctx.storage.sql`.

## Quick start

The smallest working agent is one file. With no `agent.ts`, the agent is named
after its directory:

```text
app/
  agent/
    instructions.md
```

```md
You are a concise assistant for this site. Answer in one or two sentences.
```

Add a tool by dropping a `defineAction` into `tools/`:

```ts
// app/agent/tools/create_order.ts
import { defineAction } from "@junejs/core/agent";

export default defineAction({
  id: "create_order",
  description: "Place an order for an item.",
  input: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } }, required: ["item"] },
  run: (input) => ({ orderId: 1, item: input.item, qty: input.qty ?? 1 }),
});
```

The dev server's model is the built-in Anthropic adapter. It needs the optional
peer `@anthropic-ai/sdk` installed and reads `ANTHROPIC_API_KEY` from the
environment:

```bash
bun add @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-ant-... june dev
```

Talk to the agent by POSTing to the chat endpoint, which is `/message` by default:

```bash
curl -sX POST localhost:3000/message \
  -H 'content-type: application/json' \
  -d '{"message":"order 3 widgets","session":"s1"}'
# → {"text":"..."}
```

The body is `{ message, session? }` and the response is `{ text }`, the turn's
final reply. `session` names the conversation. Send the same value again to
continue it. If you omit it, the turn uses the session `"default"`.

The runtime is configured in `june.config.ts` under `agent.runtime`. These are
the defaults:

```ts
// june.config.ts
import { defineJune } from "@junejs/core/config";

export default defineJune({
  agent: {
    runtime: {
      enabled: true,          // mounted only when the agent/ directory exists
      dir: "agent",           // relative to app/
      backend: "native",      // "native" (SQLite) | "memory" (ephemeral) | "durable" (Durable Object)
      chat: { path: "/message" },
      channels: true,         // also mount the directory's channels/
    },
  },
});
```

In dev, `backend: "durable"` falls back to `native` because dev has no Durable
Object. The dev server opens the native runtime without a file path, so its
SQLite is in-memory: turns are durable while the process runs, but the
transcript does not survive a restart.

## Status

The agent layer is part of June's `0.0.x preview`. The `agent/` directory,
channels, connections, and durable turns run in dev and on Workers Durable
Objects, and they're dogfooded. The config and channel APIs are still changing.
See [Stability](/docs/stability) for where each piece stands.

## Where to next

- [The agent/ directory](/docs/agents-directory): every file the convention reads,
  `agent.ts` fields, per-surface instructions, tools, skills, models.
- [Channels](/docs/agents-channels): HTTP, Slack, and Crisp inbound, plus channel tools.
- [Connections](/docs/agents-connections): external MCP, OpenAPI, and provider tool sources.
- [Durable turns](/docs/agents-durable-turns): checkpoints, exactly-once and
  at-least-once tools, and human-in-the-loop.
- [Deploy](/docs/agents-deploy): one Durable Object per session on Cloudflare Workers.

## Why it matters

An agent built this way can't do more than your app. Its tools are the actions
you already wrote, and they're checked by the same `run(input, ctx)` gate. Its
state follows the same durability rules in dev and in production. Adding an
agent means adding a directory, not running a second system alongside your app.
