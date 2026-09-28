---
title: "Built-in MCP"
nav: "MCP"
description: Every June app is an MCP server — defineAction() is simultaneously a server action, an MCP tool, and a manifest entry, behind one authorization gate.
date: 2026-06-12
section: Features
order: "28"
sources: [packages/core/src/mcp.ts]
---
## The feature

Turn on `agent.mcp` (it's on by default) and your app serves MCP at `/mcp` —
no separate server, no adapter, no tool re-declaration:

```ts
import { db } from "@junejs/db";

export const createUser = defineAction({
  id: "createUser",
  description: "Create a user",          // description → listed as an MCP tool
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: ({ name }, ctx) => {
    // ctx carries the principal (identity) — the SAME ctx whether the caller
    // is your React UI or an agent calling /mcp. Authorize here, once; the db
    // is ambient (import { db }), not threaded through ctx.
    return db.run("insert into users (name) values (?)", [name]);
  },
});
```

One `defineAction()` is simultaneously a **server action** (pass it to client
components as a prop), an **MCP tool** (auto-listed with its schema, plus any
behavior `annotations` you declare — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`, `title` — which `/mcp` re-serves so clients
can drive permission UX), and a **manifest entry** agents discover. There is no
"expose to agents" step and no second permission system: `run(input, ctx)` is
the gate. Mark an action `requiresPrincipal: true` and every anonymous call is
refused — UI POST and `/mcp` dispatch reject it before `run`, and agent turns
hide the tool entirely — so an agent can never do anything your UI's
authorization wouldn't allow.

## Identity and errors

The server introduces itself as your app, not as an anonymous "june". The
`initialize` handshake's `serverInfo` and `instructions`, and the server card
at `/.well-known/mcp/server-card.json` (the v1 Server Card schema), are all
derived from your config:

- **name**: your host reversed, then your site's short name
  (`june.build` → `build.june/june`). **title**: the short name.
- **instructions**: `site.description`, the tool list, and, when discovery is
  on, pointers to `/llms.txt` and the `.md` projections. Clients hand this to
  the model when it connects.
- **the card**: adds `description`, `websiteUrl`, your icons, and a
  `streamable-http` remote. The card schema caps `title` and `description` at
  100 characters, so a longer `site.description` is trimmed at a sentence or
  word boundary for the card. `instructions` keep the full text. The card is
  served as `application/mcp-server-card+json` with CORS headers, so browser
  clients can read it too.

Any of these can be set explicitly:

```ts
defineJune({
  agent: {
    mcpServer: {
      version: "1.4.0",
      description: "Search and read the June docs.",
      instructions: "Search before you fetch a page.",
    },
  },
});
```

Overrides are checked against the Server Card schema when the config loads.
A `name` that isn't `namespace/name` (or a bare name, which gets your host as
its namespace), or a `title` or `description` over 100 characters, fails the
build with an error naming the field.

Errors follow the MCP spec, so an agent can recover on its own. Calling a tool
that isn't listed is a JSON-RPC `-32602` error that names the tools that do
exist. A call that fails comes back as an `isError` result whose text is
`{"error":{"code","message"}}`, with `code` set to `invalid_input` (the input
didn't match the schema, and a hint points back to `inputSchema`),
`unauthorized` (a `requiresPrincipal` tool called without a principal), or
`execution_error` (the action threw).

## Try it on this site

This site's search is an action. Call it the way an agent would:

```bash
curl -X POST https://june.build/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

curl -X POST https://june.build/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_site","arguments":{"query":"cold start"}}}'
```

## The same tools over plain HTTP

Not every client speaks MCP. With `agent.api` (also on by default), each tool is
also `POST /api/<id>`, with its input as the JSON body and its result as the
JSON response. `/openapi.json` describes them all as OpenAPI 3.1: one
operation per tool, where `operationId` is the tool id, `requestBody` is its
input schema, and the tool's `annotations` appear as `x-mcp-annotations`. That's
the shape function-calling clients and OpenAPI tooling import directly.

```bash
curl -X POST https://june.build/api/search_site \
  -H 'content-type: application/json' \
  -d '{"query":"cold start"}'
```

It is the same dispatch as `/mcp`, and the same `run(input, ctx)` gate:
`requiresPrincipal` holds, and the input is validated against the schema
before `run`. Every failure has one JSON shape,
`{ "error": { "code", "message", "hint?" } }`, where `code` is one of
`invalid_json`, `invalid_input`, `unauthorized`, `unsupported_media_type`,
`method_not_allowed`, `not_found`, or `execution_error`. Every call needs a JSON
body with `Content-Type: application/json` (or another `+json` type), so send
`{}` to a tool that takes no input. That rule means a browser on another origin
can't reach an action with a plain form post.

Only `/api/<a registered tool id>` is claimed. Every other `/api/*` path is
still yours and falls through to your routes. Set `agent: { api: false }` to
turn the surface off.

## Why it matters

Tools are intent-shaped and policy-checked — never auto-generated CRUD. The
agent surface is exactly as capable as you declared, and exactly as
authorized as your UI.
