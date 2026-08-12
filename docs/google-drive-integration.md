# Google Drive — giving an agent read/write access to Drive

> A first-class **outbound connection**: a June agent can read files from Google
> Drive and write files back to it (create, overwrite, upsert-by-path). It ships
> as a **provider connection** (`connections/google-drive.ts`) whose operations
> are `defineAction`s, so — like everything in June — each capability is
> simultaneously an agent tool, a UI server action, and an `/mcp` tool.

## Why it's a connection (and a new connection kind)

`connections.ts` is the family of an agent's **outbound edges**. Its two original
kinds — `mcp` and `openapi` — wire a *generic* remote. Google Drive's REST API
has quirks neither can express:

- **content upload is multipart** (`uploadType=multipart`), not a JSON body;
- **downloads use `alt=media`**, and **Google-native docs** (Docs/Sheets/Slides)
  must be **exported** to text, not downloaded;
- **Drive has no real paths** — a path like `Reports/2024/summary.md` is a chain
  of `name = '…' and '<parent>' in parents` lookups, and `save_file` is a
  compound resolve→find→create/update, not a single REST op.

So Drive is a **provider connection** — a third `kind` (`defineProviderConnection`)
that brings its own transport: `connect()` returns the provider's tools as
`defineAction`s. It still joins the connection lifecycle: `connectAll` reports it,
isolates its failures (a broken provider never takes the agent down), the
durable/edge target wires it lazily, and `requiresPrincipal` stamps every tool it
exposes. This is the honest seam — Drive keeps its bespoke client but lives beside
every other outbound edge, and future providers (Notion, S3, Dropbox) reuse the
same pattern.

## Identity: the token never reaches the model

Mirroring the connection auth contract, the OAuth2 access token is resolved
**per call, server-side** via `auth(ctx)`. `ctx` is the call's identity
(`ActionContext`), so a multi-tenant app mints the **caller's** short-lived token
instead of holding one static key. Only the tool's result flows into the
transcript. Set `requiresPrincipal: true` when the Drive is user/tenant-scoped —
the tools are then hidden from anonymous turns entirely.

## The tools

| id                      | what it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `gdrive__list_files`    | List/search files & folders (Drive query syntax, or a `folderId`).  |
| `gdrive__find_file`     | Resolve a slash path (`A/B/file.txt`) → metadata, or `null`.        |
| `gdrive__read_file`     | Read text by `fileId` **or** `path`; native docs auto-exported.     |
| `gdrive__create_file`   | Create a file with content under a `folderId`/`folderPath`.         |
| `gdrive__update_file`   | Overwrite an existing file's content by `fileId`.                   |
| `gdrive__save_file`     | **Upsert by path** — the "agent produced a file, store it" tool.    |
| `gdrive__create_folder` | Create a folder (by `parentId` or `parentPath`).                    |
| `gdrive__delete_file`   | Delete a file/folder by `fileId` (`destructiveHint`).              |

Read/list/find carry `readOnlyHint`; `save_file` carries `idempotentHint`;
`delete_file` carries `destructiveHint` — so MCP clients can drive permission UX.
Pass `name` to change the `gdrive` prefix (e.g. two Drives on one agent).

## Usage — the directory convention (a connection)

Drop it in `connections/` — where outbound edges live:

```ts
// agent/connections/google-drive.ts
import { googleDriveConnection } from "@junejs/core/google-drive";

export default googleDriveConnection({
  // Resolve the caller's OAuth2 access token server-side. Wire this to your auth
  // (e.g. Better Auth account tokens) so it mints the CALLER's token.
  auth: async (ctx) => ({ token: await accessTokenFor(ctx?.user) }),
  requiresPrincipal: true, // user-scoped Drive → hidden from anonymous turns
});
```

`june gen` compiles the directory; `connectAll` wires the connection where the
agent actually runs (native at assembly, a Durable Object lazily at its first
turn), and the tools appear in `AgentDefinition.connections` like any other edge.

## Usage — programmatic

Mount the connection, or spread the raw tools:

```ts
import { defineAgent } from "@junejs/core/agent-config";
import { assembleAgent } from "@junejs/core/agent-config";
import { googleDriveConnection, googleDriveTools } from "@junejs/core/google-drive";

// As a connection (goes through connectAll → report + error isolation):
const mod = {
  config: { name: "archivist" },
  instructions: "Save your outputs to Drive and read reference docs from it.",
  tools: [], skills: [], channels: {}, channelInstructions: {},
  connections: [googleDriveConnection({ auth: () => ({ token: process.env.GOOGLE_DRIVE_TOKEN! }) })],
};
const agent = await assembleAgent(mod);

// …or spread the tools directly into a programmatic agent:
const inline = defineAgent({
  name: "archivist",
  tools: [...googleDriveTools({ auth: () => ({ token: process.env.GOOGLE_DRIVE_TOKEN! }) })],
});
```

### Example turns

- **Save an output:** `gdrive__save_file({ path: "Agent Output/report.md", content })`
  — creates the `Agent Output` folder if needed, or overwrites the file if it
  already exists.
- **Read a reference:** `gdrive__read_file({ path: "Specs/api.md" })` — resolves
  the path and returns `{ id, name, mimeType, content }`.

## Authorization — how the token is obtained

June's `auth` seam is deliberately agnostic: it wants a bearer token and doesn't
care how you got one. There are two standard models behind it.

### OAuth 2.0 (act as a user) vs Service Account (act as a robot)

| | **OAuth 2.0 (user)** | **Service Account** |
| --- | --- | --- |
| Acts as | a real end user, on **their** Drive | a robot identity with its own credentials |
| Consent | user approves once (consent screen) | none (server-to-server JWT) |
| Best for | multi-tenant SaaS — each user's own files | a central Drive the app owns; Workspace orgs |
| Storage caveat | — | a service account has ~no personal Drive; share a folder or use a **Shared Drive** |
| Maps to | `auth(ctx)` mints the **caller's** token from a stored refresh token | `auth()` mints a token from the JSON key (optionally impersonating a user via domain-wide delegation) |

Prefer the least-privilege scope: `…/auth/drive.file` (only files the app
created/opened) over the full, Google-**restricted** `…/auth/drive`.

### Getting the credentials (simplest first)

All paths start the same: create a **Google Cloud project** and **enable the
Google Drive API** (APIs & Services → Enable APIs).

- **Fastest for dev / a throwaway token — OAuth 2.0 Playground.** Configure the
  consent screen, open [the Playground](https://developers.google.com/oauthplayground),
  pick a Drive scope, authorize, and exchange for an `access_token` (+
  `refresh_token`). Zero code — paste it straight into `auth: () => ({ token })`.
- **Simplest to operate for one shared account — a Service Account key.** IAM &
  Admin → Service Accounts → create → **Keys → Add key → JSON**. Then **share the
  target folder (or Shared Drive) with the service account's email**. A library
  (`google-auth-library`) turns the JSON key into tokens automatically — no
  refresh dance, no consent screen.
- **Production multi-user — your own OAuth client.** Credentials → **Create OAuth
  client ID** → get `client_id`/`client_secret`, run the redirect flow, and store
  each user's `refresh_token`. This is where June's web nature pays off ↓.

### The web-native path: let June (via Better Auth) own the OAuth flow

The awkward part of multi-user OAuth is the **redirect dance** — consent → callback
→ exchange code → store tokens → refresh on expiry. A headless agent runtime has
to bolt on a web server for this; **June already is one** (`Request → Response`,
routes, `/mcp`, and a resolved request principal via `createPipeline({ identity })`).

So the blessed recipe is to let the **Better Auth** integration
([docs/auth-integration.md](./auth-integration.md)) run the Google OAuth provider:
it hosts consent + callback and stores each account's access/refresh tokens. Then
`auth(ctx)` just reads the caller's Google token for `ctx.user`:

```ts
// connections/google-drive.ts
export default googleDriveConnection({
  requiresPrincipal: true, // no principal ⇒ tools hidden (fail closed)
  auth: async (ctx) => {
    // Better Auth stores the linked Google account's tokens and refreshes them.
    const { accessToken } = await auth.api.getAccessToken({ providerId: "google", userId: ctx!.user!.id });
    return { token: accessToken };
  },
});
```

The end user never touches a key — they just "Sign in with Google" (granting the
Drive scope); the developer configures the OAuth client once.

### Where a helper belongs (design note)

The `auth` seam stays the source of truth and is always overridable (Service
Account, raw token, any IdP). The Better-Auth recipe above is common and fiddly
(expiry, account lookup, scope), so it is a candidate for a **blessed, overridable
helper** — but at the **host layer** (`@junejs/server`), never in the pure
`@junejs/core` (which must not depend on Better Auth). Such a helper should be
**connection-agnostic** ("get the caller's linked-account token"), reusable across
Drive and any future provider/mcp/openapi connection, and **fail closed** when no
account is linked.

