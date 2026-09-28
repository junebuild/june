// MCP server — projects the unified action registry as MCP tools over a
// Web-Standards (Request -> Response) handler, mounted at /mcp.
//
// Why a hand-rolled handler instead of the official SDK's server transport:
// `@modelcontextprotocol/sdk`'s StreamableHTTPServerTransport is Node-coupled
// (node:http IncomingMessage/ServerResponse), which breaks June's
// Web-Standards + Cloudflare story. The protocol surface we need (initialize,
// tools/list, tools/call) is small and stateless, so we implement it directly
// against the Streamable HTTP shape — identical on the native runtime and on
// Workers. (The SDK is still used client-side to verify spec compliance.)

import { ACTION_REGISTRY, actionDispatchCode, invokeAction } from "./agent";
import { MCP_CARD_TEXT_MAX, siteShortName, type AgentConfig, type SiteConfig } from "./config";
import type { ActionContext } from "./context";

export const PROTOCOL_VERSION = "2025-06-18";

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

async function handle(message: Rpc, ctx: ActionContext, server: McpServerIdentity): Promise<object | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return err(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object");
  }
  const { id, method, params } = message;
  // Validate BEFORE the notification check: a notification is still a Request
  // object, so an id-less malformed message gets -32600 (id null), not silence.
  const validId = id === undefined || id === null || typeof id === "string" || typeof id === "number";
  if (message.jsonrpc !== "2.0" || typeof method !== "string" || !validId) {
    return err(validId ? (id ?? null) : null, -32600, 'Invalid Request: needs jsonrpc "2.0" and a string method');
  }
  // A valid notification (no id) gets no response.
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: server.name,
          ...(server.title ? { title: server.title } : {}),
          version: server.version,
        },
        instructions: server.instructions,
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: mcpTools() });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (!name) return err(id, -32602, "Missing tool name");
      // Only listed tools are callable — an unknown tool is a protocol error
      // (-32602) per MCP. This also keeps bare, schema-less RSC actions off /mcp.
      const tools = mcpTools().map((t) => t.name);
      if (!tools.includes(name)) {
        return err(id, -32602, `Unknown tool: "${name}". Available tools: ${tools.join(", ") || "(none)"}`, {
          tools,
        });
      }
      try {
        // The agent's tool call runs through the SAME ctx (principal + resources)
        // the UI uses — one authorization model for both.
        const result = await invokeAction(name, args, ctx);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (error) {
        return ok(id, toolError(error));
      }
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ctx (principal + resources) is injected by the host (the pipeline) so an
// agent's tool call runs under the same authorization as the UI. Defaults to {}
// for hosts/tests without one. `server` is the identity the handshake reports.
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
    return Response.json(err(null, -32700, "Parse error"), { status: 400 });
  }

  const headers = { "mcp-protocol-version": PROTOCOL_VERSION };

  if (Array.isArray(body)) {
    // JSON-RPC 2.0 §6: an empty batch is itself an Invalid Request — ONE error
    // object (id null), not an array and not the silent 202 of an all-notification batch.
    if (body.length === 0) {
      return Response.json(err(null, -32600, "Invalid Request: empty batch"), { headers });
    }
    const responses = (await Promise.all(body.map((m) => handle(m as Rpc, ctx, server)))).filter(
      Boolean,
    );
    return responses.length
      ? Response.json(responses, { headers })
      : new Response(null, { status: 202, headers });
  }

  const response = await handle(body as Rpc, ctx, server);
  return response
    ? Response.json(response, { headers })
    : new Response(null, { status: 202, headers });
}
