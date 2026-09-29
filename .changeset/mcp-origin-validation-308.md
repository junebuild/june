---
"@junejs/core": minor
"@junejs/server": minor
"@junejs/cli": minor
---

`/mcp` and `/api/<id>` validate `Origin` and `Host`, and `june dev` binds `127.0.0.1` (#308).

- **Origin (every host).** MCP 2026-07-28 requires servers to validate `Origin` against DNS rebinding and to answer an invalid one with 403. `mcpHandler` and `apiHandler` take an `OriginPolicy`. A request without an `Origin` passes, because CLIs, SDKs, and server-side connectors don't send one. A present `Origin` must be the request's own or listed in `agent.allowedOrigins`. Otherwise the answer is `403`: on `/mcp` a JSON-RPC error with no `id` (`-32000`), on `/api` `{ error: { code: "forbidden" } }`.
- **Host (DNS rebinding).** After a rebind the attacker's page is same-origin, so only `Host` gives it away. When `agent.allowedHosts` is set, `Host` must be an IP literal or match an entry: `"example.com"`, or `".example.com"` for it and its subdomains. `june dev` always allows `localhost` and `.localhost`. The official conformance scenario `dns-rebinding-protection` now passes on both protocol eras.
- **BREAKING (dev only): `june dev` binds `127.0.0.1`.** It used to listen on every interface. `june dev --host` restores that, and `--host <addr>` binds one address. Behind a tunnel, add its domain to `agent.allowedHosts` (e.g. `".trycloudflare.com"`) to reach `/mcp` and `/api`. Production (`june start`, Workers) binds and routes as before.
- Malformed `allowedOrigins` or `allowedHosts` entries fail when the config resolves. `originRejection` and `OriginPolicy` are exported from `@junejs/core/mcp` for custom hosts.
