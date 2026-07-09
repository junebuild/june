---
"@junejs/core": minor
"@junejs/server": minor
---

Add agent connections — outbound tool sources (the mirror of channels).

- `@junejs/core/connections` — `defineMcpConnection` / `defineOpenapiConnection`
  and `connectAll`: wire an agent into an external MCP server or an OpenAPI
  service and turn each remote operation into a `<connection>__<tool>`
  `defineAction`. Because they register in the unified action registry, June both
  consumes external MCP/OpenAPI (client) AND re-serves them from its own `/mcp`
  (gateway). Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero
  `node:*`); credentials resolve per call, server-side, and never reach the
  model; a down connection is reported, not thrown.
- `@junejs/server` — `discoverAgent` now scans `connections/*.ts`, calls
  `connectAll`, merges the remote tools into the agent's tool set, and records the
  connection report on `AgentDefinition.connections`.
