---
"@junejs/core": minor
"@junejs/server": minor
"@junejs/cli": patch
---

Actions are now also plain HTTP: `POST /api/<id>` + `/openapi.json`.

- Every rich `defineAction` (one with a description, the same set `/mcp` lists)
  is also `POST /api/<id>`: the JSON body is the input and the JSON response is
  the result. It goes through the same `invokeAction`, with the same
  `createPipeline({ identity })` principal as `/mcp`, so `requiresPrincipal`
  and schema validation hold on this surface too. Only an action's canonical
  path (`/api/` + `encodeURIComponent(id)`) is claimed, and every other
  `/api/*` path still falls through to the app's routes.
- Errors have one shape, `{ error: { code, message, hint? } }`, classified the
  same way as `/mcp` (via `actionDispatchCode`): `invalid_input` (400) and
  `unauthorized` (401) are invokeAction's own refusals; anything the action
  throws — including a nested dispatch refusal it lets escape — is
  `execution_error` (500, message only, never a stack). Transport codes:
  `invalid_json` (400), `not_found` (404), `method_not_allowed` (405, with
  `Allow: POST`), `unsupported_media_type` (415). A JSON `Content-Type` is
  required (an RFC 9110 media type whose type/subtype is `application/json` or a
  `+json` type), so a cross-site browser request is always CORS-preflighted and
  can't reach an action with a simple form post.
- `GET /openapi.json` returns an OpenAPI 3.1 document generated from the
  registry: one POST operation per action, with `operationId` = the action id,
  `summary`/`description`, the input schema as a required request body (send
  `{}` when a tool takes no input), and typed 200 and error responses (a shared
  `Error` schema). An action's MCP `annotations` appear as `x-mcp-annotations`.
- The HTTP API is one more `agentServices()` entry, so it is advertised
  everywhere the MCP server is: the homepage `Link` header
  (`rel="service-desc"`), the RFC 9727 api-catalog (an `item` with its
  `service-desc`), the ARD / AI Catalog (an `api` entry), the generated
  SKILL.md ("Act (HTTP)"), an llms.txt "HTTP API" section, the actionable 404,
  and `june info`. Its media type is `application/json` everywhere, from one
  constant (`OPENAPI_MEDIA_TYPE`): IANA registers no OpenAPI media type. A
  static build projects it out with MCP — no server, nothing advertised.
- New `agent.api` flag: on by default, off with `agent.enabled: false`. New
  subpath: `@junejs/core/api` (`apiHandler`, `apiActionId`, `apiActionPath`,
  `isRoutableActionId`, `isJsonContentType`, `OPENAPI_MEDIA_TYPE`,
  `openApiDocument`). An action id that cannot be a URL path segment (`""`,
  `"."`, `".."`, or one that can't be encoded at all) stays valid for
  `defineAction` and `/mcp` but is left off this surface, with a one-time
  warning.
