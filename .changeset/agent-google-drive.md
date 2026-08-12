---
"@junejs/core": minor
"@junejs/server": patch
---

Google Drive access for agents — a first-class outbound integration.

- `@junejs/core/google-drive`: `googleDriveTools(config)` returns a set of
  `defineAction`s that give an agent read/write access to Google Drive —
  `list_files`, `find_file`, `read_file`, `create_file`, `update_file`,
  `save_file` (upsert by path), `create_folder`, `delete_file`. Because they are
  ordinary actions, each is simultaneously an agent tool, a UI server action, and
  an `/mcp` tool. Pure + `fetch`-only (edge-safe, no `node:*`), so an agent can
  hold Drive access on the native host and in a Durable Object alike.
- Identity mirrors connections: the OAuth2 access token is resolved **per call,
  server-side** via `auth(ctx)` (it never reaches the model), so a multi-tenant
  app mints the caller's short-lived token. `requiresPrincipal` hides every tool
  from anonymous turns. Read/list/find carry `readOnlyHint`, `save_file` carries
  `idempotentHint`, and `delete_file` carries `destructiveHint` for MCP
  permission UX. Drive's quirks are handled honestly: multipart content upload,
  `alt=media` downloads, `export` for Google-native docs, and slash-path
  resolution over the folder graph (with `mkdir -p` on save).
- A `tools/*.ts` file may now default-export **one** tool **or** an array of
  tools; `defineAgent`/`assembleDurable` flatten arrays (native discovery and the
  edge-compiled module both). So the whole integration drops into `agent/tools/`
  as a single `export default googleDriveTools({ … })`.
