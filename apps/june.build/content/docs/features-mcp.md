---
title: "Built-in MCP"
nav: "MCP"
description: Every June app is an MCP server — defineAction() is simultaneously a server action, an MCP tool, and a manifest entry, behind one authorization gate.
date: 2026-06-12
section: Features
order: "28"
sources: [packages/core/src/mcp.ts, packages/core/src/mcp-protocol.ts]
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

## Protocol versions

`/mcp` serves both MCP protocol eras on one endpoint, statelessly:

- **2026-07-28 (modern).** A request whose `params._meta` carries
  `io.modelcontextprotocol/protocolVersion` is served on its own. There is no
  handshake: `server/discover` advertises the version, the `tools`
  capability, the instructions and `serverInfo`. `tools/list` and
  `server/discover` results carry `resultType`, `ttlMs` and `cacheScope`.
  - **Mirrored headers are checked.** The `MCP-Protocol-Version`,
    `Mcp-Method` and `Mcp-Name` headers must match the body; a missing or
    disagreeing header gets `400` with `-32020` (HeaderMismatch).
  - **Mirrored tool parameters are checked too.** When a re-served connection
    tool declares `x-mcp-header` parameters, their `Mcp-Param-*` headers must
    match the arguments, or the call gets `-32020`.
  - **Unsupported versions** get `400` with `-32022`, which lists the
    supported versions.
  - **`initialize`, `ping` and unknown methods** get `404` with `-32601`.
- **2025-11-25, 2025-06-18 and 2025-03-26 (legacy).** Any other request
  follows the `initialize` handshake. June answers with the version the
  client asked for when it supports it, and otherwise with 2025-11-25. No
  session id is minted. JSON-RPC batches are accepted only from 2025-03-26
  clients, which send no `MCP-Protocol-Version` header; 2025-06-18 removed
  batching.

Most MCP clients still connect with the legacy handshake by default (the
official SDK's client does), so both eras stay on. The server card
advertises every version.

## Identity and errors

The server introduces itself as your app, not as an anonymous "june". The
`server/discover` and `initialize` results' `serverInfo` and `instructions`, and the server card
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

## Browsers and DNS rebinding

`/mcp` and `/api/<id>` run actions, so they check which browser is calling. A
request without an `Origin` header passes: CLIs, SDKs, and server-side
connectors don't send one. A request with an `Origin` must come from your own
origin or from one you list. Anything else gets `403`. On `/mcp` the body is a
JSON-RPC error with no `id`, as the spec requires.

An origin check alone doesn't stop DNS rebinding. The attacker's domain
resolves to `127.0.0.1`, so their page is same-origin with your local server,
and only the `Host` header gives it away. That's why `june dev` also checks
`Host`: it answers these endpoints for `localhost`, its subdomains, and IP
addresses, and nothing else. It also binds `127.0.0.1` only. Pass `--host` to
open it to your network, for example to test from a phone.

```ts
defineJune({
  agent: {
    // A separate web app that calls the API from the browser.
    allowedOrigins: ["https://app.example.com"],
    // Reach `june dev` through a tunnel. Production checks Host only when set.
    allowedHosts: [".trycloudflare.com"],
  },
});
```

An `allowedHosts` entry is a host name without scheme or port. A leading dot
also matches its subdomains. A malformed entry in either list fails the build.

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

When nothing answers a path under `/api`, whether a tool or one of your routes,
June treats it as an API miss rather than a missing page:

- `GET /api` (or `/api/`) returns a small JSON index: the `/openapi.json` URL,
  each tool as `{ id, method: "POST", path, description }`, and the error
  shape. It carries a `Link: </openapi.json>; rel="service-desc"` header.
- Any other unmatched `/api/*` path gets the JSON
  `{ "error": { "code": "not_found", … } }`, for every method and every
  `Accept`, never an HTML page. There are no invented versions: `/api/v1` is a
  miss like any other path.

The order under `/api` is:

1. A registered tool's own path, `/api/<id>`, is dispatched to the tool before
   routing, so a route of yours at that exact path is never reached.
2. Every other path goes to your routes. A route of yours at `/api` or at any
   `/api/<path>` that isn't a tool's replaces the index or the error there.
3. Only a path that neither a tool nor a route claims gets the index (at
   `/api`) or the JSON 404.

## Why it matters

Tools are intent-shaped and policy-checked — never auto-generated CRUD. The
agent surface is exactly as capable as you declared, and exactly as
authorized as your UI.
