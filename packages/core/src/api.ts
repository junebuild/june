// HTTP API — projects the unified action registry as plain REST operations:
// every rich defineAction (one with a description, the same set /mcp lists) is
// also `POST /api/<id>`, and `/openapi.json` describes them all. Same registry,
// same invokeAction, same identity as /mcp — a third door onto one set of
// actions, for agents and clients that speak OpenAPI / function calling rather
// than MCP.
//
// Only `/api/<registered action id>` is claimed: any other /api/* path falls
// through to the app's own routes, so an app keeps owning its /api namespace.

import { ACTION_REGISTRY, actionDispatchCode, invokeAction, type AnyAction } from "./agent";
import type { ActionContext } from "./context";
import { corsHeaders, originRejection, preflightResponse, withCors, type OriginPolicy } from "./origin-policy";

export const API_PREFIX = "/api/";

// The media type /openapi.json is served AND advertised with (Link header,
// api-catalog) — one constant so they can't drift. Plain JSON: as of 2026-09-28
// IANA registers no OpenAPI type (`application/openapi+json` is only an IETF
// httpapi draft), and an unregistered type would be advertised on faith.
export const OPENAPI_MEDIA_TYPE = "application/json";

// A request Content-Type this surface accepts: a whole RFC 9110 media-type
// (§8.3.1, parameters per §5.6.6) whose type/subtype is exactly application/json
// or a structured-suffix `<type>/<subtype>+json`:
//   media-type = type "/" subtype *( OWS ";" OWS [ parameter ] )
//   parameter  = token "=" ( token / quoted-string )
// Case-insensitive. The parameter is optional in the grammar, so `;;` and a
// trailing `;` are valid; `; garbage` is not. It backs the CSRF control: the
// CORS-safelisted types a cross-site form or no-cors fetch can send
// (text/plain, forms, no header) all fail it.
const TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]+";
const OWS = "[ \\t]*";
const QUOTED = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\t \\x21-\\x7e\\x80-\\xff])*"';
const PARAMETER = `${TOKEN}=(?:${TOKEN}|${QUOTED})`;
const JSON_MEDIA_TYPE = new RegExp(
  `^(?:application/json|${TOKEN}/${TOKEN}\\+json)(?:${OWS};${OWS}(?:${PARAMETER})?)*$`,
  "i",
);
export function isJsonContentType(header: string | null): boolean {
  // Surrounding whitespace is not part of a field value (RFC 9110 §5.5).
  return !!header && JSON_MEDIA_TYPE.test(header.trim());
}

// An action id's path segment under /api/. encodeURIComponent is reversible for
// every id — "/" "%" "?" "#" and non-ASCII all escape — except the ones URL
// parsing itself rewrites: "." and ".." are dot segments (removed, and "%2E" is
// treated as a dot too, so no escape rescues them), and "" is the bare prefix.
// A string with a lone surrogate can't be encoded at all (URIError).
export function apiActionPath(id: string): string {
  return `${API_PREFIX}${encodeURIComponent(id)}`;
}

// Whether `id` survives the trip through a URL: its path parses back unchanged.
// Stated as the round trip itself rather than a list of bad ids, so routing and
// the OpenAPI document can never disagree about which actions are reachable.
export function isRoutableActionId(id: string): boolean {
  if (!id) return false;
  let path: string;
  try {
    path = apiActionPath(id);
  } catch {
    return false; // not encodable at all (a lone surrogate → URIError)
  }
  return new URL(path, "http://june.invalid").pathname === path;
}

// An id valid for defineAction (and so for /mcp and RSC) but unreachable here is
// left off the REST surface, with one warning per id rather than per request.
const warnedUnroutable = new Set<string>();

// The actions this surface exposes — rich ones only, mirroring mcpTools(): a bare
// RSC server action registered via action(fn, id) carries no schema to describe.
function apiActions(): AnyAction[] {
  return [...ACTION_REGISTRY.values()].filter((a) => {
    if (!a.description) return false;
    if (isRoutableActionId(a.id)) return true;
    if (!warnedUnroutable.has(a.id)) {
      warnedUnroutable.add(a.id);
      console.warn(
        `[june] action id ${JSON.stringify(a.id)} can't be a URL path segment, so it is not served at /api/<id> or listed in /openapi.json (it still works over /mcp).`,
      );
    }
    return false;
  });
}

// The action a pathname addresses, or null when it isn't this surface's —
// the caller then lets the request fall through to the app's routes.
export function apiActionId(pathname: string): string | null {
  if (!pathname.startsWith(API_PREFIX)) return null;
  const raw = pathname.slice(API_PREFIX.length);
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null; // malformed escape → not ours
  }
  // Only the canonical path — the one /openapi.json advertises — is claimed.
  // Decoding alone would let the nested app path /api/a/b resolve to action
  // "a/b" (whose path is /api/a%2Fb), or accept an alternate spelling like
  // /api/%61; anything but the exact encoding falls through to the app.
  // (servedAction first: it proves the id encodable before apiActionPath runs.)
  if (!servedAction(id) || pathname !== apiActionPath(id)) return null;
  return id;
}

// The registered action this surface serves under `id`: rich, and routable.
function servedAction(id: string): AnyAction | undefined {
  const action = ACTION_REGISTRY.get(id);
  return action?.description && isRoutableActionId(id) ? action : undefined;
}

export type ApiErrorCode =
  | "method_not_allowed"
  | "not_found"
  | "unsupported_media_type"
  | "invalid_json"
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "execution_error";

// Every failure on this surface has ONE shape, so an agent can branch on `code`
// and act on `hint` instead of scraping prose.
function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  hint?: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error: { code, message, ...(hint ? { hint } : {}) } }, { status, headers });
}

const schemaHint = (id: string) => `The input schema is operationId "${id}" in /openapi.json.`;

// ctx (principal + resources) comes from the host, exactly as for /mcp — so a
// requiresPrincipal action is gated the same way on both surfaces.
export async function apiHandler(request: Request, id: string, ctx: ActionContext = {}, policy: OriginPolicy = {}): Promise<Response> {
  // The JSON content-type rule in serveApi stops a cross-site form POST, but
  // not DNS rebinding, which makes the attacker's page same-origin — the same
  // policy as /mcp (#308). An allowed cross-origin caller gets CORS.
  const refused = originRejection(request, policy);
  if (refused !== undefined) return apiForbidden(request, refused);
  const cors = corsHeaders(request, policy);
  if (cors && request.method === "OPTIONS") return preflightResponse(request, cors);
  const response = await serveApi(request, id, ctx);
  return cors ? withCors(response, cors) : response;
}

// 403 for a request the origin policy refused. Exported so a host that checks
// the policy before resolving identity answers with the same body.
export function apiForbidden(request: Request, reason: string): Response {
  const res = apiError(403, "forbidden", reason);
  return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

async function serveApi(request: Request, id: string, ctx: ActionContext): Promise<Response> {
  // A HEAD response carries the same status + headers as GET, never a body.
  const reply = (res: Response) =>
    request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;

  // Resolve first: 405 (and its pointer at the schema) is only for an action
  // /openapi.json actually lists.
  const action = servedAction(id);
  if (!action) {
    // Not on this surface: unregistered (rolled back between routing and
    // dispatch), a bare server action, or an id with no path — excluded here
    // exactly as apiActionId() and /openapi.json exclude it, even when a host
    // calls apiHandler directly.
    return reply(apiError(404, "not_found", `Unknown action "${id}".`, "List the operations in /openapi.json."));
  }
  if (request.method !== "POST") {
    // HEAD is refused like GET — an action has no representation to fetch.
    return reply(
      apiError(405, "method_not_allowed", `${request.method} is not supported — call actions with POST.`, schemaHint(id), {
        allow: "POST",
      }),
    );
  }

  // A JSON content type is REQUIRED, empty body or not: it makes every cross-site
  // browser call a CORS-preflighted one, so a page on another origin can't ride
  // the visitor's cookies into an action with a simple form/text POST (CSRF).
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return apiError(
      415,
      "unsupported_media_type",
      "The request must be `Content-Type: application/json`.",
      "Send the action input as a JSON object with that header (an empty body means `{}`).",
    );
  }

  // An empty body is `{}` — an action with no required input is callable bare.
  let input: unknown = {};
  const raw = await request.text();
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      return apiError(400, "invalid_json", "The request body is not valid JSON.", "Send a JSON object as the body.");
    }
  }

  try {
    const result = await invokeAction(id, input, ctx);
    return Response.json(result ?? null);
  } catch (error) {
    return dispatchFailure(id, error);
  }
}

// One classification with /mcp: actionDispatchCode() is set only on refusals
// invokeAction raised itself BEFORE the action ran — never on whatever run() (or
// a nested dispatch it let escape) threw — so those map to their own status,
// and everything else is an execution_error. The message only, never a stack.
function dispatchFailure(id: string, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  switch (actionDispatchCode(error)) {
    case "unauthorized":
      return apiError(401, "unauthorized", message, "Authenticate the request the way this site's UI does, then retry.");
    case "invalid_input":
      return apiError(400, "invalid_input", message, schemaHint(id));
    case "unknown_action":
      // unregistered between servedAction() and dispatch
      return apiError(404, "not_found", message, "List the operations in /openapi.json.");
    default:
      return apiError(500, "execution_error", message);
  }
}

// --- the /api namespace --------------------------------------------------------
// June claims /api as its REST namespace: a path there that neither an action nor
// an app route answers is an API miss, not a page — so it gets this surface's
// JSON error (whatever the Accept header asked for), and the bare root gets a
// small machine-readable index. The host calls these only AFTER app routing found
// nothing, so an app route under /api always wins.

// Whether a (raw, locale-free) pathname is in the /api namespace.
export function isApiNamespace(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith(API_PREFIX);
}

const API_ROOT = new Set(["/api", "/api/"]);
const INDEX_METHODS = "GET, HEAD";

// A HEAD response carries the same status + headers as GET, never a body.
function forMethod(request: Request, res: Response): Response {
  return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

// The response for an /api path no action and no app route claimed: the index
// at the root (GET/HEAD), else a JSON 404 pointing at /openapi.json. Versions are
// never invented — /api/v1 is a miss like any other path.
export function apiNamespaceResponse(request: Request, origin: string): Response {
  const { pathname } = new URL(request.url);
  if (API_ROOT.has(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return apiError(
        405,
        "method_not_allowed",
        `${request.method} is not supported on the API index — call an action with POST /api/<id>.`,
        "GET /api lists the actions; /openapi.json describes them.",
        { allow: INDEX_METHODS },
      );
    }
    return forMethod(
      request,
      Response.json(apiIndex(origin), {
        headers: {
          "access-control-allow-origin": "*",
          // RFC 8288: the index's machine-readable description, typed as served
          link: `</openapi.json>; rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`,
        },
      }),
    );
  }
  return forMethod(
    request,
    apiError(
      404,
      "not_found",
      `No API endpoint at ${pathname}.`,
      "Actions are POST /api/<id>; GET /api lists them and /openapi.json describes them.",
    ),
  );
}

// GET /api: where the API is described, what it serves, and how it fails. The
// OpenAPI document stays the full contract; this is the root an agent or a
// scanner can verify with one request.
export function apiIndex(origin: string) {
  return {
    openapi: `${origin}/openapi.json`,
    actions: apiActions().map((a) => ({
      id: a.id,
      method: "POST",
      path: apiActionPath(a.id),
      description: a.description,
    })),
    errors: {
      shape: { error: { code: "string", message: "string", hint: "string (optional)" } },
      codes: ERROR_CODES,
    },
  };
}

// --- OpenAPI -----------------------------------------------------------------

const ERROR_CODES: ApiErrorCode[] = [
  "method_not_allowed",
  "not_found",
  "unsupported_media_type",
  "invalid_json",
  "invalid_input",
  "unauthorized",
  "forbidden",
  "execution_error",
];

function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
}

// One sentence for `summary` — the description's first sentence, capped.
function summarize(action: AnyAction): string {
  if (action.annotations?.title) return action.annotations.title;
  const first = action.description.split(/(?<=[.!?])\s/)[0] ?? action.description;
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

// OpenAPI 3.1 for every action on this surface. operationId = the action id —
// the same name the tool has on /mcp and WebMCP, so every surface agrees.
export function openApiDocument(
  origin: string,
  site?: { name?: string; description?: string },
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const action of apiActions()) {
    const responses: Record<string, unknown> = {
      "200": {
        description: `The result of ${action.id}, as JSON.`,
        content: { "application/json": { schema: { description: `Whatever ${action.id} returns.` } } },
      },
      "400": errorResponse("The body is not JSON (invalid_json) or does not match the input schema (invalid_input)."),
      "415": errorResponse("The request is not Content-Type: application/json (unsupported_media_type)."),
      ...(action.requiresPrincipal ? { "401": errorResponse("The action requires an authenticated caller (unauthorized).") } : {}),
      "403": errorResponse("A browser on an origin or host the site doesn't allow made the call (forbidden)."),
      "500": errorResponse("The action threw (execution_error)."),
    };
    paths[apiActionPath(action.id)] = {
      post: {
        operationId: action.id,
        summary: summarize(action),
        description: action.description,
        // Always required, even when no field is: the handler demands a JSON
        // Content-Type (the CSRF control), and generated clients only send one
        // alongside a body — so an input-less action is called with `{}`.
        requestBody: { required: true, content: { "application/json": { schema: action.input } } },
        responses,
        // MCP ToolAnnotations (readOnlyHint, destructiveHint, …) carried verbatim.
        ...(action.annotations ? { "x-mcp-annotations": action.annotations } : {}),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: site?.name ?? "June app",
      ...(site?.description ? { description: site.description } : {}),
      version: "0.0.0",
    },
    servers: [{ url: origin }],
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: ERROR_CODES, description: "Machine-readable error code." },
                message: { type: "string", description: "What went wrong." },
                hint: { type: "string", description: "How to fix the request, when known." },
              },
            },
          },
        },
      },
    },
  };
}
