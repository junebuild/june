---
"@junejs/core": minor
"@junejs/server": patch
---

Google Drive access for agents — as a new `provider` connection kind.

- `connections` gains a third kind alongside `mcp` and `openapi`:
  `defineProviderConnection({ name, connect, requiresPrincipal? })`. A provider
  brings its OWN transport — `connect(ctx?)` returns the provider's tools as
  `defineAction`s — for remotes the generic mcp/openapi clients can't express
  (multipart uploads, `alt=media` downloads, compound path→id operations). It
  still joins the connection lifecycle: `connectAll` reports it (kind
  `"provider"`), isolates its failures (a broken provider never takes the agent
  down), the durable/edge target wires it lazily, and `requiresPrincipal` stamps
  every tool it exposes.
- `@junejs/core/google-drive`: `googleDriveConnection(config)` is the first
  provider — Google Drive read/write for an agent (`list_files`, `find_file`,
  `read_file`, `create_file`, `update_file`, `save_file` upsert-by-path,
  `create_folder`, `delete_file`). Drop it in `connections/google-drive.ts`.
  `googleDriveTools(config)` is also exported for spreading the raw actions into a
  programmatic `defineAgent`. Pure + `fetch`-only (edge-safe, no `node:*`).
  Identity mirrors connections: the OAuth2 access token is resolved per call,
  server-side via `auth(ctx)` (never reaches the model), so a multi-tenant app
  mints the caller's short-lived token. Read/list/find carry `readOnlyHint`,
  `save_file` carries `idempotentHint`, `delete_file` carries `destructiveHint`.
- A `tools/*.ts` file may now default-export one tool OR an array of tools;
  `defineAgent`/`assembleDurable` flatten arrays (native discovery and the
  edge-compiled module both).
