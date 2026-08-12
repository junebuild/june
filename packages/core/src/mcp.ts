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
import type { ActionContext } from "./context";

const PROTOCOL_VERSION = "2025-06-18";

// Warn at most once per process when the tool surface is empty (see tools/list).
let warnedEmptyTools = false;

// Test-only: the guard above is a process-wide singleton, so a test asserting the
// warning would otherwise be order-dependent across the whole monorepo run. Reset it.
export function __resetEmptyToolsWarning(): void {
  warnedEmptyTools = false;
}

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

async function handle(message: Rpc, ctx: ActionContext): Promise<object | null> {
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
    case "tools/list": {
      const tools = mcpTools();
      if (tools.length === 0 && !warnedEmptyTools) {
        // Reaching this handler means /mcp is mounted (enabled) yet the surface
        // is empty — the exact silent no-op where a defineAction() sits in a
        // file the app graph never imports. Warn once, pointing to the fix.
        warnedEmptyTools = true;
        console.warn(
          "[june] /mcp exposes no tools — no defineAction() with a description is registered. " +
            "Agent tools live in agent/tools/*.ts (each default-exports a defineAction); " +
            "a standalone app/actions.ts is not auto-loaded into the app graph.",
        );
      }
      return ok(id, { tools });
    }
    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (!name) return err(id, -32602, "Missing tool name");
      try {
        // The agent's tool call runs through the SAME ctx (principal + resources)
        // the UI uses — one authorization model for both.
        const result = await invokeAction(name, args, ctx);
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

// ctx (principal + resources) is injected by the host (the pipeline) so an
// agent's tool call runs under the same authorization as the UI. Defaults to {}
// for hosts/tests without one.
export async function mcpHandler(request: Request, ctx: ActionContext = {}): Promise<Response> {
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
    const responses = (await Promise.all(body.map((m) => handle(m as Rpc, ctx)))).filter(
      Boolean,
    );
    return responses.length
      ? Response.json(responses, { headers })
      : new Response(null, { status: 202, headers });
  }

  const response = await handle(body as Rpc, ctx);
  return response
    ? Response.json(response, { headers })
    : new Response(null, { status: 202, headers });
}
