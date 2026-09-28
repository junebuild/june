---
"@junejs/core": patch
"@junejs/server": patch
---

`/mcp` introduces itself as your app and reports errors the MCP spec's way.

- `initialize` returns a derived `serverInfo` (`name` = reversed host / short
  site name, e.g. `build.june/june`; `title` = the site's short name) and
  `instructions` generated from `site.description`, the tool list, and — with
  discovery on — the `/llms.txt` and `.md` pointers. Previously every app
  answered as `{ name: "june", version: "0.0.0" }` with no instructions.
- New `agent.mcpServer: { name?, title?, description?, version?, instructions? }`
  overrides any derived field. `resolveAgent` validates these against the v1
  Server Card schema (name pattern, title/description ≤ 100 chars, version
  ≤ 255) and throws a config error naming the field.
  `mcpServerIdentity(origin, { site, agent })` is exported from
  `@junejs/core/mcp`; `mcpHandler` takes it as an optional third argument.
- `/.well-known/mcp/server-card.json` follows the v1 Server Card schema
  (SEP-2127): `$schema`, reverse-DNS `name`, `title`, `description`,
  `websiteUrl`, `icons` (from the site's icon set, resolved like the document's
  `<link>`), and a `streamable-http` remote. A derived description or title
  longer than the schema's 100 characters is trimmed at a sentence or word
  boundary (`fitCardText`), and `instructions` keep the full text. The card is
  served as `application/mcp-server-card+json` with the spec's CORS headers,
  `Cache-Control: public, max-age=3600`, and an `OPTIONS` preflight answer. The
  api-catalog `service-desc` and the `Link` header advertise the card with that
  same type, through one exported constant, `MCP_SERVER_CARD_TYPE`. The
  earlier `url` / `protocolVersion` / `capabilities` / `tools` fields stay for
  existing readers. `mcpServerCard(origin, opts?)` gains an optional
  `{ site, agent, icons, basePath }`. `withBasePath` is exported from
  `@junejs/core/document`.
- `tools/call` on a tool that isn't listed is now a JSON-RPC `-32602` error
  naming the available tools (was an `isError` result). This also means bare,
  description-less actions are no longer callable over `/mcp`: they were never
  listed.
- A failed tool call's `isError` text is now JSON,
  `{"error":{"code","message"}}`, where `code` is `invalid_input`,
  `unauthorized`, or `execution_error`. `invokeAction` tags the errors it
  throws before running with `error.code`, and `actionDispatchCode(error)`
  (from `@junejs/core/agent`) recognizes only those. Any other `code` an action
  throws (`ECONNRESET`, say) is reported as `execution_error`. That includes a
  nested `invokeAction` refusal that escapes the action's `run()`: the marker is
  cleared at that boundary, on the same error object. A nested refusal the action
  catches itself keeps its code.
- A message without `jsonrpc: "2.0"` or a string `method` gets `-32600 Invalid
  Request`, even without an `id`. Only a valid notification gets the silent `202`.
  An empty batch `[]` gets one `-32600` error object (id null).
