// connections.ts — CONNECTIONS: an agent's OUTBOUND edge (the mirror of channels).
//
// Where a channel brings the world IN (messages), a connection reaches the world
// OUT (tools): it wires the agent into an external server it does NOT author — an
// MCP server, or any HTTP API with an OpenAPI document — and turns each remote
// operation into a callable tool named `<connection>__<tool>`.
//
// June twist: those remote tools are registered as `defineAction`s, so they join
// the SAME unified registry as local tools. June both CONSUMES external
// MCP/OpenAPI (client, like eve) AND re-serves everything from its own /mcp
// (server) — a transparent MCP gateway. A headless framework only does the client
// half. Credentials never reach the model: `auth` is resolved per call,
// server-side; only the tool's result flows into the transcript.
//
// Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero node:*), so an
// agent can hold connections on native and on edge alike.

import { defineAction, type AnyAction, type JsonSchema } from "./agent";

type Auth = () => Promise<{ token: string }> | { token: string };
type Headers = Record<string, string>;

export type McpConnection = { kind: "mcp"; name: string; url: string; headers?: Headers; auth?: Auth };
export type OpenapiConnection = {
  kind: "openapi";
  name: string;
  url: string; // URL of the OpenAPI document
  baseUrl?: string; // overrides servers[0].url
  headers?: Headers;
  auth?: Auth;
};
export type Connection = McpConnection | OpenapiConnection;

export function defineMcpConnection(c: Omit<McpConnection, "kind">): McpConnection {
  return { kind: "mcp", ...c };
}
export function defineOpenapiConnection(c: Omit<OpenapiConnection, "kind">): OpenapiConnection {
  return { kind: "openapi", ...c };
}

export type ConnectionReport = { name: string; kind: string; url: string; tools: string[]; error?: string };

async function resolveHeaders(c: Connection): Promise<Headers> {
  const h: Headers = { "content-type": "application/json", ...(c.headers ?? {}) };
  if (c.auth) {
    const { token } = await c.auth();
    h["authorization"] = `Bearer ${token}`;
  }
  return h;
}

// --- MCP client ---------------------------------------------------------------

async function rpc(url: string, headers: Headers, method: string, params?: object) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function connectMcp(c: McpConnection): Promise<AnyAction[]> {
  await rpc(c.url, await resolveHeaders(c), "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "june", version: "0.0.0" },
  });
  const listed = (await rpc(c.url, await resolveHeaders(c), "tools/list")) as {
    tools: { name: string; description?: string; inputSchema?: JsonSchema }[];
  };

  return listed.tools.map((t) =>
    defineAction({
      id: `${c.name}__${t.name}`,
      description: `[${c.name}] ${t.description ?? t.name}`,
      input: t.inputSchema ?? { type: "object", properties: {} },
      // async ⇒ the engine treats this as a remote (at-least-once) tool.
      run: async (input: unknown) => {
        const result = (await rpc(c.url, await resolveHeaders(c), "tools/call", { name: t.name, arguments: input })) as {
          content?: { type: string; text?: string }[];
        };
        const text = result.content?.find((b) => b.type === "text")?.text;
        if (text === undefined) return result;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    }),
  );
}

// --- OpenAPI client (minimal, honest subset) ----------------------------------

type OpenApiDoc = { servers?: { url: string }[]; paths: Record<string, Record<string, Operation>> };
type Operation = {
  operationId?: string;
  summary?: string;
  parameters?: { name: string; in: "query" | "path"; required?: boolean; schema?: { type?: string }; description?: string }[];
  requestBody?: { content?: { "application/json"?: { schema?: JsonSchema } } };
};

async function connectOpenapi(c: OpenapiConnection): Promise<AnyAction[]> {
  const doc = (await (await fetch(c.url, { headers: await resolveHeaders(c) })).json()) as OpenApiDoc;
  const baseUrl = c.baseUrl ?? doc.servers?.[0]?.url ?? new URL(c.url).origin;

  const actions: AnyAction[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const opId = op.operationId ?? `${method}_${path.replace(/[/{}]/g, "_")}`;
      const properties: JsonSchema["properties"] = {};
      const required: string[] = [];
      for (const p of op.parameters ?? []) {
        properties[p.name] = { type: p.schema?.type ?? "string", description: p.description };
        if (p.required) required.push(p.name);
      }
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema?.properties) {
        Object.assign(properties, bodySchema.properties);
        for (const r of bodySchema.required ?? []) required.push(r);
      }

      actions.push(
        defineAction({
          id: `${c.name}__${opId}`,
          description: `[${c.name}] ${op.summary ?? opId}`,
          input: { type: "object", properties, ...(required.length ? { required } : {}) },
          run: async (input: Record<string, unknown>) => {
            let url = baseUrl + path;
            const query = new URLSearchParams();
            const body: Record<string, unknown> = { ...input };
            for (const p of op.parameters ?? []) {
              if (!(p.name in input)) continue;
              if (p.in === "path") url = url.replace(`{${p.name}}`, encodeURIComponent(String(input[p.name])));
              else query.set(p.name, String(input[p.name]));
              delete body[p.name];
            }
            const qs = query.toString();
            if (qs) url += `?${qs}`;
            const init: RequestInit = { method: method.toUpperCase(), headers: await resolveHeaders(c) };
            if (method.toUpperCase() !== "GET" && bodySchema) init.body = JSON.stringify(body);
            return (await fetch(url, init)).json();
          },
        }),
      );
    }
  }
  return actions;
}

// --- discover all -------------------------------------------------------------

// Connect every connection, collecting their tools. A down connection is
// reported with an `error` but never throws — one bad remote must not take the
// whole agent down.
export async function connectAll(connections: Connection[]): Promise<{ actions: AnyAction[]; report: ConnectionReport[] }> {
  const actions: AnyAction[] = [];
  const report: ConnectionReport[] = [];
  for (const c of connections) {
    try {
      const a = c.kind === "mcp" ? await connectMcp(c) : await connectOpenapi(c);
      actions.push(...a);
      report.push({ name: c.name, kind: c.kind, url: c.url, tools: a.map((x) => x.id) });
    } catch (e) {
      report.push({ name: c.name, kind: c.kind, url: c.url, tools: [], error: String(e) });
    }
  }
  return { actions, report };
}
