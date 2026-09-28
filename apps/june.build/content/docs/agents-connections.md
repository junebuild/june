---
title: "Connections: where tools come from"
nav: "Connections"
description: A connection is an agent's outbound edge — an MCP server, an OpenAPI API, or a provider like Google Drive declared in agent/connections/*.ts, whose operations become <conn>__<tool> tools authenticated per call, server-side.
date: 2026-09-27
section: Agents
order: "16.3"
sources: [packages/core/src/connections.ts, packages/core/src/mcp-client.ts, packages/core/src/mcp-protocol.ts, packages/core/src/google-drive.ts, packages/core/src/github.ts, packages/core/src/agent-config.ts, packages/june/src/connection-auth.ts, packages/june/src/agent-durable.ts, packages/june/src/agent-discover.ts, docs/google-drive-integration.md, packages/core/CHANGELOG.md]
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

Remote tools are built as `defineAction`s, so the agent calls them through the
same `run(input, ctx)` path as your own tools. Where they are *also* listed
depends on the target:

- **Native (`june dev`, a self-mounted runtime)** — connections are opened in
  the same process that serves your app, so their actions land in the one
  action registry and your app's [`/mcp`](/docs/features-mcp) re-serves them
  under the same authorization gate.
- **Workers** — connections are opened lazily *inside each session's Durable
  Object* (see [Errors and the report](#errors-and-the-report)), a separate
  isolate from the worker that answers `/mcp`. The agent gets the tools; the
  worker's `/mcp` does not list them. To expose a remote tool on a deployed
  `/mcp`, wrap it in a `defineAction` of your own in `app/`.

## Three kinds

All three are exported from `@junejs/core/connections`.

| factory | fields | tools come from |
|---|---|---|
| `defineMcpConnection` | `name`, `url`, `headers?`, `auth?`, `requiresPrincipal?` | `initialize` + `tools/list` on the server |
| `defineOpenapiConnection` | `name`, `url` (the OpenAPI doc), `baseUrl?`, `headers?`, `auth?`, `requiresPrincipal?`, `include?`, `docAuth?` | each path × method in the doc, or those `include` selects |
| `defineProviderConnection` | `name`, `connect`, `url?`, `requiresPrincipal?` | whatever `connect()` returns |

- **MCP** — Streamable HTTP, in either protocol era:
  - **2026-07-28 first, the 2025 era as a fallback.** June first sends
    `server/discover`. A server offering 2026-07-28 gets stateless
    requests, each carrying its protocol version in `_meta` and mirrored
    into `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers.
  - **Falling back to the 2025 handshake.** Anything a 2025-era server
    answers to that probe makes June run `initialize` and
    `notifications/initialized` instead, and keep the `Mcp-Session-Id` the
    server mints (an expired session is re-initialized once).
  - **Legacy sessions are per credential.** Each distinct set of resolved
    headers, so each tenant under a per-caller `auth(ctx)`, opens and reuses
    its own session; a tenant never rides on another tenant's session or on
    discovery's. A `ping` the server sends on the response stream is
    answered; other server requests get method-not-found.
  - **A broken 2026-07-28 response stream** is re-issued with a new request
    id, at most twice.
  - **Errors, not downgrades.** 401/403, 5xx and network failures fail the
    connection; they never trigger the fallback. Responses may be JSON or
    SSE.
  - **Paginated listings are read to the end.** June follows `nextCursor`
    until the server omits it; an empty-string cursor is a cursor, not the
    end. A page with no `tools` array, a server that repeats a cursor, or
    a listing past 100 pages fails the connection rather than dropping
    tools silently.
  - **`x-mcp-header`.** When a modern server annotates tool parameters, June
    mirrors them into `Mcp-Param-*` headers, encoding values as Base64 where
    needed. It drops a tool whose annotations are invalid, with a warning.
  - **Results.** A call returns the tool's `structuredContent` when there is
    one; otherwise it returns the first text block, parsed as JSON when it
    is JSON. `isError: true` is thrown, so the model sees a failed call. June
    declares no client capabilities: a server asking for input (elicitation,
    sampling) gets an error, while a `requestState`-only retry is echoed,
    up to three rounds.
  - **Descriptions and annotations.** The tool's description is prefixed
    `[<name>]`, and its `annotations` (`readOnlyHint`, `destructiveHint`, …)
    carry through when June re-serves it.
  - **Tool ids.** MCP allows dots in tool names (`admin.tools.list`) and
    names up to 128 characters before the `<name>__` prefix, so ids follow
    the same rule as OpenAPI's: characters outside `[A-Za-z0-9_-]` become
    `_`, ids are cut to 128 characters, and a colliding id gets a numeric
    suffix. The remote tool is still called by its own name. A name that is
    already valid keeps its id, in both kinds: only reduced ids are ever
    suffixed, so adding a dotted tool to a server never moves an existing
    one.
- **OpenAPI** — a minimal subset of OpenAPI 3:
  - **Tool ids** are `<name>__<operationId>`, or an id built from the method
    and path when an operation has none. Characters outside `[A-Za-z0-9_-]`
    become `_`, ids are cut to 128 characters, and a colliding id gets a
    numeric suffix — all to satisfy the tool-name rule of the Claude API. For
    example, GitHub's `issues/list-for-repo` becomes
    `github__issues_list-for-repo`.
  - **The input schema** is built from the path, query and header
    parameters, including path-level ones, plus the properties of a JSON
    request body.
  - **`$ref`s are followed** when they point inside the document
    (`#/components/…`). They are inlined up to three levels deep, and a cyclic
    or remote ref becomes an open schema. Cookie parameters, and parameters
    whose ref can't be resolved, are left out.
  - **The base URL** is `baseUrl`, else `servers[0].url`, else the document's
    origin.
  - **Errors:** a non-2xx response throws, with its status and the start of
    its body. An empty 2xx body returns `null`, and a body that isn't JSON
    returns its text.
- **Choosing operations (`include`)** — large APIs describe hundreds of
  operations; GitHub's has 1224. Each one becomes a tool, and every tool is
  offered to the model on every turn. `include` takes operationIds or tags
  (`["issues/create", "pulls"]`), or a predicate that receives
  `{ operationId, method, path, tags }`. When a connection without `include`
  produces more than 100 tools, June logs a warning.
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

**The OpenAPI document fetch sends no credentials unless it has to.**
Documents often live on a different host from the API: GitHub's is on
`raw.githubusercontent.com`, and others sit on a CDN or a docs site. So
`headers` and `auth` go with the document request only when `baseUrl` is set
and has the same origin as `url`. Set `docAuth: true` to send them anyway, for
a protected document on another host, or `docAuth: false` to never send them.
Credentials belong to the document's origin, so if the document redirects to
another origin, that request goes without them. If a document fetched without
credentials answers 401 or 403, the connection fails with an error that says
which fix applies: `baseUrl` or `docAuth`, or, after a cross-origin redirect,
pointing `url` at the final location.

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

## GitHub App tokens

An agent that works on code needs a GitHub credential. `@junejs/core/github`
mints GitHub App installation tokens that are short-lived, scoped to one
repository and limited to the permissions a call names. One exception applies:
GitHub makes read-only `metadata` mandatory for any App with repository access,
so every token also carries `metadata: read`, whether the call names it or not.
You
don't need a personal access token or any App-auth code of your own:

```ts
// agent/connections/github.ts
import { defineMcpConnection } from "@junejs/core/connections";
import { githubApp } from "@junejs/core/github";

export const gh = githubApp({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
});

// Your mapping from the caller to the org whose installation to use.
const orgOf = (user: { id: string }) => `acme-${user.id}`;

// A connection's `auth`, scoped by the caller.
export default defineMcpConnection({
  name: "github",
  url: "https://mcp.example.com/mcp",
  // Tenant-scoped auth ⇒ gate the tools: without it, an anonymous call (no
  // ctx.user) would get the discovery credential below.
  requiresPrincipal: true,
  auth: gh.auth((ctx) =>
    ctx?.user
      ? { owner: orgOf(ctx.user), repo: "widgets", permissions: { issues: "write" } }
      : // Discovery (initialize, tools/list) runs with no ctx: read-only.
        { owner: "acme", repo: "widgets", permissions: { metadata: "read" } },
  ),
});
```

Anywhere server-side, such as inside an action, `gh.token(...)` returns the
token as a string:

```ts
const token = await gh.token({ owner: "acme", repo: "widgets", permissions: { contents: "read" } });
```

- **What it does:** it signs an RS256 App JWT with WebCrypto, looks up the
  repo's installation, and then exchanges it for a token narrowed to
  `repositories: [repo]` and your `permissions`. Tokens are cached per
  `(owner, repo, permissions)` until five minutes before they expire, and
  concurrent calls for the same scope share one exchange. It needs no
  `node:*` modules, so it also runs on the edge.
- **The private key** can be PKCS#1, which is what GitHub gives you
  (`BEGIN RSA PRIVATE KEY`), or PKCS#8. Literal `\n` escapes, CRLF line
  endings, surrounding quotes and a base64-wrapped PEM are all accepted.
- **`permissions` is required.** An exchange without it would carry every
  permission the installation has. Least privilege is your policy. For
  example, `contents: "read"` to clone, and `write` only after a human
  approves.
- **Errors** are `GitHubAppError`s with a `code`:

  | `code` | meaning |
  |---|---|
  | `not_installed` | The App isn't installed on the repo. A public repo can still be read anonymously. |
  | `permission_denied` | The App lacks a permission, or GitHub granted less than you asked for. It fails closed. |
  | `unauthorized` | GitHub rejected the JWT: check the `appId`, the key and the clock. |
  | `rate_limited` | GitHub hit a primary or secondary rate limit. This is transient; `retryAfter` gives the seconds to wait when GitHub says. |
  | `network` | `fetch` itself failed (DNS, connection, TLS). The original error is the `cause`. |
  | `invalid_key` | The private key could not be parsed or imported. |
  | `invalid_request` | The owner, repo or permissions are malformed. |
  | `http` | Any other error response, or a success response missing what GitHub documents (such as the token). |

  If GitHub later answers 401 to a cached token, call `gh.invalidate(req)`.
- **Other options:** `apiBaseUrl` for GitHub Enterprise Server
  (`https://<host>/api/v3`), `userAgent`, `fetch` and `now`.

**Where the token goes is your decision.** Never hand an installation token
to an environment the model controls, such as a sandbox shell, an env var a
tool can print, or a git remote or credential helper inside that sandbox. Code
running there can read the token from the environment, from a git hook, or
through a replaced binary. Clone and push from a server-side action instead,
and give the sandbox only the working tree.

With the function form of `auth`, the resolver also runs with no `ctx` during
an MCP connection's discovery. Return the narrowest request you can for that
case, and set `requiresPrincipal: true`. Anonymous tool calls also arrive with
no `ctx.user`, and without the gate they would receive the discovery credential.

## Why it matters

The agent's reach is declared in files you can read: which servers, which
tools, under which identity. Credentials are resolved server-side, per call and
per caller, and never enter the transcript. A broken remote shows up in a
report instead of taking the agent down.
