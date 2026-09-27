---
title: "Connections: where tools come from"
nav: "Connections"
description: A connection is an agent's outbound edge — an MCP server, an OpenAPI API, or a provider like Google Drive declared in agent/connections/*.ts, whose operations become <conn>__<tool> tools authenticated per call, server-side.
date: 2026-09-27
section: Agents
order: "16.3"
sources: [packages/core/src/connections.ts, packages/core/src/google-drive.ts, packages/core/src/agent-config.ts, packages/june/src/connection-auth.ts, packages/june/src/agent-durable.ts, packages/june/src/agent-discover.ts, docs/google-drive-integration.md, packages/core/CHANGELOG.md]
---
## The shape

A channel brings messages in; a connection reaches out. Each file in
`agent/connections/*.ts` default-exports one connection definition. At assembly
June connects it, and every remote operation becomes a tool named
`<connection>__<tool>`:

```ts
// agent/connections/github.ts
import { defineMcpConnection } from "@junejs/core/connections";

export default defineMcpConnection({
  name: "github",                          // tools: github__<remote tool name>
  url: "https://mcp.example.com/mcp",
  headers: { "x-client": "june" },         // static headers, sent on every call
  auth: async (ctx) => ({ token: await tokenFor(ctx?.user) }), // your resolver
  requiresPrincipal: true,                 // hide every tool from anonymous turns
});
```

Remote tools are registered as `defineAction`s, so they join the same registry
as your own tools: callable by the agent, and re-served from your app's
[`/mcp`](/docs/features-mcp) under the same authorization gate.

## Three kinds

All three are exported from `@junejs/core/connections`.

| factory | fields | tools come from |
|---|---|---|
| `defineMcpConnection` | `name`, `url`, `headers?`, `auth?`, `requiresPrincipal?` | `initialize` + `tools/list` on the server |
| `defineOpenapiConnection` | `name`, `url` (the OpenAPI doc), `baseUrl?`, `headers?`, `auth?`, `requiresPrincipal?` | each path × method in the doc |
| `defineProviderConnection` | `name`, `connect`, `url?`, `requiresPrincipal?` | whatever `connect()` returns |

- **MCP** — the tool's description is prefixed `[<name>]` and its
  `annotations` (`readOnlyHint`, `destructiveHint`, …) carry through when
  June re-serves it. A call's first text content block is parsed as JSON,
  falling back to the raw text.
- **OpenAPI** — a minimal subset: the tool id is `<name>__<operationId>`
  (or one built from the method and path when there is none); query/path parameters and a
  JSON request body's properties form the input schema. The base URL is
  `baseUrl`, else `servers[0].url`, else the doc's origin.
- **Provider** — the escape hatch for transports the generic clients can't
  express (multipart uploads, `alt=media` downloads, path→id lookups).
  `connect({ requiresPrincipal })` returns `defineAction`s; when the connection
  sets `requiresPrincipal`, every returned tool must already be built with it
  or connecting fails.

## Auth: tokens never reach the model

`auth(ctx)` returns `{ token }` and is resolved per call, on the server; the
token goes out as `Authorization: Bearer …` alongside `headers`, and only the
tool's result enters the transcript. `ctx` is the call's identity — `ctx.user`
is the turn's resolved principal (see [channels](/docs/agents-channels)) or the
request's principal on UI and `/mcp` calls — so `auth` can mint the *caller's*
short-lived token instead of holding one static key.

MCP and OpenAPI connections also call `auth()` with no `ctx` during discovery
(`initialize`, `tools/list`, fetching the OpenAPI doc), before any turn exists.
An identity-dependent `auth` must return a discovery-scoped credential when
`ctx` is `undefined`.

## Errors and the report

One bad remote never takes the agent down. `connectAll` records each connection
as a `ConnectionReport`:

```ts
type ConnectionReport = { name: string; kind: string; url: string; tools: string[]; error?: string };
```

A failed connection gets `tools: []` plus its `error`, and any tools it
registered before failing are removed again. Natively the reports land on
`AgentDefinition.connections`. Two tools with the same name fail assembly.

**On the edge**, connecting is network I/O that a Durable Object constructor
can't await, so connections travel to the DO as definitions and are wired
lazily, once, before the first turn. Their tools merge into the agent's tool
set then; a failed connection is logged with `console.error` and skipped.

## Google Drive

Drive ships as a provider connection in `@junejs/core/google-drive`:

```ts
// agent/connections/google-drive.ts
import { googleDriveConnection } from "@junejs/core/google-drive";
import { betterAuthAccessToken } from "@junejs/server";
import { auth } from "../../lib/auth"; // your Better Auth instance

export default googleDriveConnection({
  requiresPrincipal: true,                                    // no principal ⇒ tools hidden
  auth: betterAuthAccessToken(auth, { providerId: "google" }), // the caller's linked Google token
});
```

| tool | does |
|---|---|
| `gdrive__list_files` | list/search (Drive query syntax, or a `folderId`) |
| `gdrive__find_file` | resolve `A/B/file.txt` → `{ found, file }` |
| `gdrive__read_file` | read text by `fileId` or `path`; Docs/Sheets/Slides are exported to text |
| `gdrive__create_file` | create with content under `folderId` / `folderPath` |
| `gdrive__update_file` | overwrite content by `fileId` |
| `gdrive__save_file` | upsert by path, creating folders as needed |
| `gdrive__create_folder` | create by `parentId` / `parentPath` |
| `gdrive__delete_file` | permanent delete (`destructiveHint`) |

Read, list, and find carry `readOnlyHint`. Other options: `name` (the tool
prefix, default `gdrive` — use it for two Drives on one agent), `rootFolderId`
(where paths resolve; default My Drive `root`), `apiBaseUrl`, `uploadBaseUrl`,
`fetch`. A name matching two siblings fails rather than picking one.

To spread the tools into a programmatic agent, or default-export them from
`agent/tools/`, use `googleDriveTools(config)` instead. It returns the same
array but skips the connection lifecycle (no report, no failure isolation).

**Choosing the authorization model.**

| | OAuth 2.0 (acts as a user) | Service account (acts as a robot) |
|---|---|---|
| Whose Drive | each user's own | a central Drive the app owns |
| `auth` | mints the caller's token from their stored refresh token | mints a token from the JSON key |
| Setup | consent screen; users sign in with Google | share a folder or Shared Drive with the account's email, and set `rootFolderId` to it |

Prefer the `drive.file` scope over the restricted full `drive` scope. For the
service-account or single-token case, `auth` is a one-liner:

```ts
googleDriveConnection({
  rootFolderId: process.env.DRIVE_SHARED_FOLDER_ID,
  auth: async () => ({ token: await mintServiceAccountToken(saKey) }), // your minter
});
```

**Linked-account helpers** (from `@junejs/server`):

- `linkedAccountAuth({ providerId, store })` — give it an `AccountTokenStore`
  (`({ userId, providerId }) → { accessToken } | null`) and it returns an
  `auth(ctx)`. It fails closed: a missing principal or an unlinked account
  throws.
- `betterAuthAccountTokenStore(auth)` / `betterAuthAccessToken(auth, {
  providerId })` — the Better Auth store and the one-call shorthand. They
  match Better Auth structurally, so importing them adds no `better-auth`
  dependency.

Because they throw without a principal, these helpers suit provider
connections. An MCP or OpenAPI connection that needs auth for discovery gets
called with no `ctx`, so a fail-closed helper would leave it with zero tools.
Give those a discovery-scoped credential instead.

## Why it matters

The agent's reach is declared in files you can read: which servers, which
tools, under which identity. Credentials are resolved server-side, per call and
per caller, and never enter the transcript. A broken remote shows up in a
report instead of taking the agent down.
