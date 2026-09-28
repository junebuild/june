---
"@junejs/core": patch
"@junejs/server": patch
---

Agent discovery gains the ARD catalog and an Agent Skills index, and the api-catalog lists its APIs as RFC 9727 items. All derived from the app graph and on with `agent.discovery`.

- `/.well-known/agent-skills/index.json` (Agent Skills Discovery RFC v0.2.0): one generated skill per app, named after the host (`june.build` → `june-build`), served at `/.well-known/agent-skills/<name>/SKILL.md`. It teaches an agent to use the site: `llms.txt`, Markdown projections, and each MCP tool with its parameters. The index entry carries the `sha256` digest of the exact served bytes.
- `/.well-known/ai-catalog.json` and `/.well-known/ard.json`: an AI Catalog (the format ARD crawls) listing the MCP server card and the skill, with `urn:air:<host>:…` identifiers and a `did:web:<host>` host. Served as `application/json` with `Access-Control-Allow-Origin: *`, advertised by `robots.txt` (`Agentmap:`), `<link rel="ai-catalog">` in every page head, and the `Link` header.
- `/.well-known/api-catalog` follows RFC 9727:
  - Per §4, the first linkset context is the catalog itself, listing each API (the site, `/mcp`) as an `item`. Each API then has its own context with `service-desc` / `service-doc`, and the MCP card is typed `application/mcp-server-card+json`.
  - The response carries the RFC 9727 `profile` parameter.
  - Per §2, both `GET` and `HEAD` answer with a `Link: </.well-known/api-catalog>; rel="api-catalog"` header.
  - `agentServices()` is the one list every catalog reads from.
- Catalogs are published, and advertised (by `<link rel="ai-catalog">`, the `Link` header relation, and robots `Agentmap:`), only when `agent.discovery` is on, the site owns the domain root (no `basePath`), and it can name its public origin. `buildLinkHeader()` and `robotsTxt()` take `{ catalogs }` for the host's rule. An unmatched path under `/.well-known/agent-skills/` answers 404 while the skills are served, instead of reaching app routing.
- The discovery surfaces served by the pipeline (`llms.txt`, `robots.txt`, `sitemap.xml`, the api-catalog, the MCP server card, the ARD catalogs, and the skills) answer `HEAD` as well as `GET`: the same status and headers, no body. The Agent Skills Discovery RFC requires `HEAD` for the skills index and artifacts, and RFC 9727 for the api-catalog; the rest follow for consistency. The MCP card's CORS `access-control-allow-methods` is now `GET, HEAD`.
- A static build prerenders the ARD catalog (both paths), the skills index, and the generated `SKILL.md` alongside `llms.txt` and `sitemap.xml`, but only for a root deploy with `site.url` or `deploy.domain`, so no file names the placeholder prerender host. It publishes no `robots.txt`, api-catalog, or MCP card.
- Static builds render with MCP projected out, because a static host serves no `/mcp`. `llms.txt` drops its MCP claims, the catalogs and skill list no MCP server, and pages register no WebMCP tools. Previously a static `llms.txt` advertised a `/mcp` endpoint that didn't exist.
