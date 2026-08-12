# Google Drive — giving an agent read/write access to Drive

> A first-class **outbound integration**: a June agent can read files from Google
> Drive and write files back to it (create, overwrite, upsert-by-path). Ships as a
> set of `defineAction` tools, so — like everything in June — the same capability
> is simultaneously an agent tool, a UI server action, and an `/mcp` tool.

## Why it isn't just a connection

`connections.ts` wires a **generic** remote — any MCP server or OpenAPI document —
and turns each operation into a `<connection>__<tool>` action. Google Drive's REST
API has quirks the generic OpenAPI client can't honor:

- **content upload is multipart** (`uploadType=multipart`, a metadata part + a
  media part), not a JSON body;
- **downloads use `alt=media`**, and **Google-native docs** (Docs/Sheets/Slides)
  must be **exported** to text, not downloaded;
- **Drive has no real paths** — a path like `Reports/2024/summary.md` is a chain
  of `name = '…' and '<parent>' in parents` lookups.

So Drive is its own small, hand-written client (`@junejs/core/google-drive`,
pure + `fetch`-only, edge-safe) — but it lands in the **same** place every other
capability does: `defineAction`s in the unified registry. Nothing new to wire.

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

## Usage — the directory convention

A tool file may default-export **one** tool or an **array** of tools, so the whole
integration drops into `agent/tools/` as a single file:

```ts
// agent/tools/google-drive.ts
import { googleDriveTools } from "@junejs/core/google-drive";

export default googleDriveTools({
  // Resolve the caller's OAuth2 access token server-side. Wire this to your auth
  // (e.g. Better Auth account tokens) so it mints the CALLER's token.
  auth: async (ctx) => ({ token: await accessTokenFor(ctx?.user) }),
  requiresPrincipal: true, // user-scoped Drive → hidden from anonymous turns
});
```

`june gen` compiles the directory (arrays are flattened at assembly, on both the
native host and the edge/Durable-Object target).

## Usage — programmatic

```ts
import { defineAgent } from "@junejs/core/agent-config";
import { googleDriveTools } from "@junejs/core/google-drive";

const agent = defineAgent({
  name: "archivist",
  instructions: "Save your outputs to Drive and read reference docs from it.",
  tools: [
    ...googleDriveTools({ auth: () => ({ token: process.env.GOOGLE_DRIVE_TOKEN! }) }),
  ],
});
```

### Example turns

- **Save an output:** `gdrive__save_file({ path: "Agent Output/report.md", content })`
  — creates the `Agent Output` folder if needed, or overwrites the file if it
  already exists.
- **Read a reference:** `gdrive__read_file({ path: "Specs/api.md" })` — resolves
  the path and returns `{ id, name, mimeType, content }`.

## Scopes

The token needs the Drive scope your operations require —
`https://www.googleapis.com/auth/drive.file` (files the app created/opened) or
`https://www.googleapis.com/auth/drive` (full access). June never sees the OAuth
consent flow; it only consumes the access token your `auth` returns.
