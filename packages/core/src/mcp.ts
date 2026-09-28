// MCP server — projects the unified action registry as MCP tools over a
// Web-Standards (Request -> Response) handler, mounted at /mcp.
//
// Why a hand-rolled handler instead of the official SDK's server transport:
// `@modelcontextprotocol/sdk`'s StreamableHTTPServerTransport is Node-coupled
// (node:http IncomingMessage/ServerResponse), which breaks June's
// Web-Standards + Cloudflare story. The protocol surface we need (server/discover
// or initialize, tools/list, tools/call) is small and stateless, so we implement
// it directly against the Streamable HTTP shape — identical on the native runtime
// and on Workers. Both protocol eras are served (see mcpHandler); the official
// SDK v2 client and server verify interop in test/mcp-interop.test.ts.

import { ACTION_REGISTRY, actionDispatchCode, invokeAction } from "./agent";
import { MCP_CARD_TEXT_MAX, siteShortName, type AgentConfig, type SiteConfig } from "./config";
import type { ActionContext } from "./context";
import {
  decodeHeaderValue,
  ERROR,
  HEADER,
  headerParamMismatch,
  headerParams,
  LATEST_LEGACY_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  META,
  MODERN_PROTOCOL_VERSION,
  NAME_SOURCE,
} from "./mcp-protocol";

// The revision June leads with, and every revision the endpoint serves (the
// server card advertises the list).
export const PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS] as const;

type Rpc = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function ok(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function err(id: Rpc["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

// Only rich actions (with a description) are surfaced as MCP tools; bare RSC
// server actions registered via action(fn, id) carry no schema. Exported as
// mcpTools() so the WebMCP document injection registers the SAME set.
export function mcpTools() {
  return [...ACTION_REGISTRY.values()]
    .filter((action) => action.description)
    .map((action) => ({
      name: action.id,
      description: action.description,
      inputSchema: action.input,
      // MCP ToolAnnotations (spec 2025-11-25) — behavior hints clients use for
      // permission UX (auto-approve read-only, confirm destructive). Advisory.
      ...(action.annotations ? { annotations: action.annotations } : {}),
    }));
}

// Who this server is — the initialize handshake's serverInfo + instructions, and
// the server card's identity (see mcpServerCard in ./discovery). The host builds
// it from the app's config; the handler falls back to one derived from the
// request's origin alone. name/title/description always satisfy the v1 Server
// Card schema (see MCP_SERVER_NAME / MCP_CARD_TEXT_MAX in ./config).
export type McpServerIdentity = {
  name: string; // reverse-DNS with one slash ("build.june/june") — a valid server-card name too
  title?: string; // ≤ 100 chars
  version: string;
  description?: string; // the card's one-liner, ≤ 100 chars; instructions carry the full text
  instructions: string;
};

// "june.build" → "build.june" — the server-card / MCP registry naming convention.
// Anything outside the namespace alphabet (an IPv6 literal's brackets/colons) → "-".
function reverseHost(host: string): string {
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  const reversed = hostname
    .split(".")
    .reverse()
    .join(".")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return reversed || "localhost";
}

// A server-card name segment allows [a-zA-Z0-9._-] only. A title with no latin
// letters or digits (a CJK site name, say) has no honest ASCII slug → "mcp".
function nameSlug(text: string | undefined): string {
  const slug = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64)
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "mcp";
}

// Fit text into the card's length limit without a mid-word cut: keep whole sentences
// when a sentence end lands in the back half of the window, else cut at the last
// word boundary and add "…"; unbroken text (CJK has no spaces) is cut at the limit.
// Counts code points, as JSON Schema's maxLength does.
export function fitCardText(text: string, max = MCP_CARD_TEXT_MAX): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join("");
  const window = chars.slice(0, max - 1).join(""); // room for the ellipsis
  const sentenceEnd = Math.max(
    ...[...window.matchAll(/[.!?](?=\s)|[。！？]/g)].map((m) => m.index! + m[0].length),
    -1,
  );
  if (sentenceEnd >= window.length / 2) return window.slice(0, sentenceEnd);
  const space = window.search(/\s\S*$/);
  const cut = space >= window.length / 2 ? window.slice(0, space) : window;
  return cut.replace(/[\s,;:—–-]+$/u, "") + "…";
}

// The default usage guidance: what the app is, what its tools are, and — when the
// discovery surface is on — where the rest of the app lives for an agent. Tool
// details stay in tools/list; this is the orientation a client hands the model.
function defaultInstructions(
  origin: string,
  title: string | undefined,
  description: string | undefined,
  discovery: boolean,
): string {
  const tools = mcpTools().map((t) => t.name);
  const lines = [
    `${title ?? new URL(origin).host} (${origin})${description ? ` — ${description}` : ""}`,
    "",
    tools.length
      ? `Tools: ${tools.join(", ")}. Each tool's description and inputSchema are in tools/list; call them with tools/call. A failed call returns isError with a JSON body {"error":{"code","message"}}.`
      : "This server currently exposes no tools.",
  ];
  if (discovery) {
    lines.push(
      `Every page on ${origin} also answers as Markdown: append .md to its URL or send Accept: text/markdown.`,
      `Start from ${origin}/llms.txt — the site's index for agents.`,
    );
  }
  return lines.join("\n");
}

// The server identity for one origin. Overrides come from `agent.mcpServer`;
// everything unset is derived (site → title/description, the action registry →
// instructions), so a June app never introduces itself as an anonymous server.
export function mcpServerIdentity(
  origin: string,
  opts: { site?: SiteConfig; agent?: Pick<AgentConfig, "discovery" | "mcpServer"> } = {},
): McpServerIdentity {
  const { site = {}, agent } = opts;
  // Explicit overrides were validated when the config resolved (validateMcpServer);
  // derived values are made valid here.
  const o = agent?.mcpServer ?? {};
  const shortName = siteShortName(site);
  const title = o.title ?? (shortName ? fitCardText(shortName) : undefined);
  const base = reverseHost(new URL(origin).host);
  const segment = o.name && !o.name.includes("/") ? o.name : nameSlug(title);
  // The schema caps the whole name at 200; only an absurd host can reach that.
  const name = o.name?.includes("/") ? o.name : `${base.slice(0, 199 - segment.length)}/${segment}`;
  const description = o.description ?? (site.description ? fitCardText(site.description) : undefined);
  return {
    name,
    ...(title ? { title } : {}),
    version: o.version ?? "0.0.0",
    ...(description ? { description } : {}),
    // The instructions carry the FULL site description — no card limit applies there.
    instructions: o.instructions ?? defaultInstructions(origin, title, site.description, agent?.discovery ?? false),
  };
}

// A failed tools/call is a tool-execution error (isError), not a protocol error,
// so the model sees it and can correct itself. The text is JSON with a stable code:
//   invalid_input / unauthorized — refused before the action ran (invokeAction's codes)
//   execution_error              — anything the action (or a dependency) threw, whatever
//                                  `code` it carried ("ECONNRESET" stays in the message)
function toolError(error: unknown) {
  const code = actionDispatchCode(error) ?? "execution_error";
  const body = {
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(code === "invalid_input"
        ? { hint: "Check the arguments against this tool's inputSchema in tools/list." }
        : {}),
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

// tools/call, shared by both eras: only listed tools are callable (an unknown
// tool is a protocol error, -32602 — which also keeps bare, schema-less RSC
// actions off /mcp), and the call runs under the SAME ctx (principal +
// resources) the UI uses — one authorization model for both.
async function callTool(id: Rpc["id"], params: Record<string, unknown> | undefined, ctx: ActionContext): Promise<{ error: object } | { result: Record<string, unknown> }> {
  const name = params?.name as string | undefined;
  const args = (params?.arguments as Record<string, unknown>) ?? {};
  if (!name) return { error: err(id, ERROR.invalidParams, "Missing tool name") };
  const tools = mcpTools().map((t) => t.name);
  if (!tools.includes(name)) {
    return { error: err(id, ERROR.invalidParams, `Unknown tool: "${name}". Available tools: ${tools.join(", ") || "(none)"}`, { tools }) };
  }
  try {
    const result = await invokeAction(name, args, ctx);
    return { result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
  } catch (error) {
    return { result: toolError(error) };
  }
}

// --- legacy era (2025-11-25 and earlier): initialize handshake --------------------

// Stateless on this side too: the server mints no Mcp-Session-Id (spec: MAY), so
// every request stands alone and a legacy client's session header is ignored.
async function handleLegacy(message: Rpc, ctx: ActionContext, server: McpServerIdentity): Promise<object | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return err(null, ERROR.invalidRequest, "Invalid Request: expected a JSON-RPC 2.0 object");
  }
  const { id, method, params } = message;
  // Validate BEFORE the notification check: a notification is still a Request
  // object, so an id-less malformed message gets -32600 (id null), not silence.
  const validId = id === undefined || id === null || typeof id === "string" || typeof id === "number";
  if (message.jsonrpc !== "2.0" || typeof method !== "string" || !validId) {
    return err(validId ? (id ?? null) : null, ERROR.invalidRequest, 'Invalid Request: needs jsonrpc "2.0" and a string method');
  }
  // A valid notification (no id) gets no response.
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize": {
      // Version negotiation: echo a version June speaks, else offer the latest.
      const requested = params?.protocolVersion;
      const version = (LEGACY_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? (requested as string) : LATEST_LEGACY_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(server),
        instructions: server.instructions,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: mcpTools() });
    case "tools/call": {
      const outcome = await callTool(id, params, ctx);
      return "error" in outcome ? outcome.error : ok(id, outcome.result);
    }
    default:
      return err(id, ERROR.methodNotFound, `Method not found: ${method}`);
  }
}

// --- modern era (2026-07-28): stateless, per-request envelope ----------------------

type ModernReply = { status: number; body: object | null };

function serverInfo(server: McpServerIdentity) {
  return { name: server.name, ...(server.title ? { title: server.title } : {}), version: server.version };
}

// The routing headers a modern client mirrors from the body. A missing or
// disagreeing header is a HeaderMismatch (400 + -32020): intermediaries may have
// routed on the header while the server executes the body. (Headers PRESENT but
// disagreeing are checked earlier, before version support — see handleModern.)
function missingHeader(request: Request, message: Rpc): string | undefined {
  const h = request.headers;
  if (h.get(HEADER.protocolVersion) === null) return "MCP-Protocol-Version header is missing";
  if (h.get(HEADER.method) === null) return "Mcp-Method header is missing";
  const source = NAME_SOURCE[message.method!];
  if (source) {
    const raw = h.get(HEADER.name);
    if (raw === null) return "Mcp-Name header is missing";
    const name = decodeHeaderValue(raw);
    if (name === undefined) return "Mcp-Name header is not a valid Base64 sentinel";
    if (name !== message.params?.[source]) return `Mcp-Name header '${name}' does not match body '${String(message.params?.[source])}'`;
  }
  return undefined;
}

async function handleModern(request: Request, message: Rpc, ctx: ActionContext, server: McpServerIdentity): Promise<ModernReply> {
  const { id, method } = message;
  const params = message.params ?? {};
  const meta = params._meta as Record<string, unknown>;
  const version = meta[META.protocolVersion];
  const bad = (code: number, text: string, data?: unknown): ModernReply => ({ status: 400, body: err(id ?? null, code, text, data) });

  // Validation order mirrors the official SDK (inboundClassification.ts, then
  // createMcpHandler's serveModern): shape → envelope → headers PRESENT but
  // disagreeing with the body → version support → headers MISSING (requests
  // only; notifications are exempt) → per-tool Mcp-Param-* at dispatch.
  //
  // 1. JSON-RPC shape. A request id is a string or an integer — never null
  //    (spec: "the ID MUST NOT be null"); an absent id is a notification.
  const validId = id === undefined || typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
  if (message.jsonrpc !== "2.0" || typeof method !== "string" || !validId) {
    return { status: 400, body: err(null, ERROR.invalidRequest, 'Invalid Request: needs jsonrpc "2.0", a string method, and a string or integer id') };
  }
  // 2. The envelope.
  const caps = meta[META.clientCapabilities];
  if (typeof version !== "string" || !caps || typeof caps !== "object" || Array.isArray(caps)) {
    return bad(ERROR.invalidParams, `Invalid params: _meta needs a string "${META.protocolVersion}" and an object "${META.clientCapabilities}"`);
  }
  // 3. Headers present but disagreeing with the body.
  const headerVersion = request.headers.get(HEADER.protocolVersion);
  if (headerVersion !== null && headerVersion !== version) {
    return bad(ERROR.headerMismatch, `Header mismatch: MCP-Protocol-Version header '${headerVersion}' does not match body '${version}'`);
  }
  const headerMethod = request.headers.get(HEADER.method);
  if (headerMethod !== null && headerMethod !== method) {
    return bad(ERROR.headerMismatch, `Header mismatch: Mcp-Method header '${headerMethod}' does not match body '${method}'`);
  }
  // 4. Version support. `supported` lists the MODERN revisions — the same set
  //    server/discover advertises; legacy peers negotiate through initialize.
  if (version !== MODERN_PROTOCOL_VERSION) {
    return bad(ERROR.unsupportedProtocolVersion, "Unsupported protocol version", { supported: [MODERN_PROTOCOL_VERSION], requested: version });
  }
  // This revision defines no client-to-server notifications over HTTP; accept and ignore.
  if (id === undefined) return { status: 202, body: null };
  // 5. Required headers missing (and Mcp-Name, which needs decoding).
  const missing = missingHeader(request, message);
  if (missing) return bad(ERROR.headerMismatch, `Header mismatch: ${missing}`);

  const complete = (result: Record<string, unknown>): ModernReply => ({
    status: 200,
    body: ok(id, { resultType: "complete", ...result, _meta: { [META.serverInfo]: serverInfo(server) } }),
  });
  switch (method) {
    case "server/discover":
      return complete({
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: server.instructions,
        // Freshness hints (required on discover and list results). The tool set is
        // the same for every caller (identity gates CALLS, not the listing) → public.
        ttlMs: 0,
        cacheScope: "public",
      });
    case "tools/list":
      return complete({ tools: mcpTools(), ttlMs: 0, cacheScope: "public" });
    case "tools/call": {
      // 6. A re-served connection tool may declare x-mcp-header parameters; the
      //    mirrored Mcp-Param-* headers must then agree with the arguments.
      const tool = mcpTools().find((t) => t.name === params.name);
      const found = tool ? headerParams(tool.inputSchema) : undefined;
      if (found && "params" in found && found.params.length) {
        const why = headerParamMismatch(found.params, params.arguments, request.headers);
        if (why) return bad(ERROR.headerMismatch, `Header mismatch: ${why}`);
      }
      const outcome = await callTool(id, params, ctx);
      return "error" in outcome ? { status: 200, body: outcome.error } : complete(outcome.result);
    }
    default:
      // initialize / ping are legacy-only; everything else is unknown. MUST be 404.
      return { status: 404, body: err(id, ERROR.methodNotFound, `Method not found: ${method}`) };
  }
}

const isModern = (message: unknown): message is Rpc =>
  !!message &&
  typeof message === "object" &&
  !Array.isArray(message) &&
  !!(message as Rpc).params?._meta &&
  typeof (message as Rpc).params?._meta === "object" &&
  META.protocolVersion in ((message as Rpc).params!._meta as object);

// ctx (principal + resources) is injected by the host (the pipeline) so an
// agent's tool call runs under the same authorization as the UI. Defaults to {}
// for hosts/tests without one. `server` is the identity discover/initialize report.
//
// One endpoint, both eras (spec 2026-07-28, versioning: a dual-era server MAY
// serve both concurrently): a request whose params._meta carries a protocol
// version is served statelessly as 2026-07-28; anything else follows the 2025
// Streamable HTTP rules (initialize → tools/*). JSON responses only — the spec
// lets the server choose JSON per request.
export async function mcpHandler(
  request: Request,
  ctx: ActionContext = {},
  server: McpServerIdentity = mcpServerIdentity(new URL(request.url).origin),
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("MCP endpoint — POST JSON-RPC (Streamable HTTP)", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(err(null, ERROR.parse, "Parse error"), { status: 400 });
  }

  if (isModern(body)) {
    const reply = await handleModern(request, body, ctx, server);
    return reply.body ? Response.json(reply.body, { status: reply.status }) : new Response(null, { status: reply.status });
  }

  // Legacy. A modern MCP-Protocol-Version header without the body envelope is a
  // malformed modern request, not a legacy one.
  const headerVersion = request.headers.get(HEADER.protocolVersion);
  if (headerVersion !== null && headerVersion >= MODERN_PROTOCOL_VERSION) {
    return Response.json(err((body as Rpc)?.id ?? null, ERROR.invalidParams, `Invalid params: a ${headerVersion} request must carry params._meta["${META.protocolVersion}"]`), { status: 400 });
  }
  // 2025-06-18+ clients send the negotiated version; one June doesn't speak is a 400.
  if (headerVersion !== null && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) {
    return Response.json(err(null, ERROR.invalidRequest, `Unsupported MCP-Protocol-Version: ${headerVersion} (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`), { status: 400 });
  }

  if (Array.isArray(body)) {
    // Batches exist only in 2025-03-26 — 2025-06-18 removed them, and that is the
    // revision that introduced MCP-Protocol-Version, so a batch carrying the
    // header is from a revision without batching. Nor may a batch smuggle
    // modern messages.
    if (headerVersion !== null) {
      return Response.json(err(null, ERROR.invalidRequest, `Invalid Request: JSON-RPC batches are not part of MCP ${headerVersion}`), { status: 400 });
    }
    if (body.some(isModern)) return Response.json(err(null, ERROR.invalidRequest, "Invalid Request: a batch cannot carry 2026-07-28 requests"), { status: 400 });
    // JSON-RPC 2.0 §6: an empty batch is itself an Invalid Request — ONE error
    // object (id null), not an array and not the silent 202 of an all-notification batch.
    if (body.length === 0) return Response.json(err(null, ERROR.invalidRequest, "Invalid Request: empty batch"));
    const responses = (await Promise.all(body.map((m) => handleLegacy(m as Rpc, ctx, server)))).filter(Boolean);
    return responses.length ? Response.json(responses) : new Response(null, { status: 202 });
  }

  const response = await handleLegacy(body as Rpc, ctx, server);
  return response ? Response.json(response) : new Response(null, { status: 202 });
}
