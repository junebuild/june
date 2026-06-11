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

import { ACTION_REGISTRY, invokeAction } from "./agent";

const PROTOCOL_VERSION = "2025-06-18";

type Rpc = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function ok(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function err(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

// Only rich actions (with a description) are surfaced as MCP tools; bare RSC
// server actions registered via action(fn, id) carry no schema.
function tools() {
  return [...ACTION_REGISTRY.values()]
    .filter((action) => action.description)
    .map((action) => ({
      name: action.id,
      description: action.description,
      inputSchema: action.input,
    }));
}

async function handle(message: Rpc): Promise<object | null> {
  const { id, method, params } = message;
  // Notifications (no id) get no response.
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "june", version: "0.0.0" },
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: tools() });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (!name) return err(id, -32602, "Missing tool name");
      try {
        const result = await invokeAction(name, args);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (error) {
        return ok(id, {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        });
      }
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function mcpHandler(request: Request): Promise<Response> {
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
    const responses = (await Promise.all(body.map((m) => handle(m as Rpc)))).filter(
      Boolean,
    );
    return responses.length
      ? Response.json(responses, { headers })
      : new Response(null, { status: 202, headers });
  }

  const response = await handle(body as Rpc);
  return response
    ? Response.json(response, { headers })
    : new Response(null, { status: 202, headers });
}
