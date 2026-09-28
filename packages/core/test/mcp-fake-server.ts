// A fake MCP server for client tests, in either protocol era, answering JSON or
// SSE. It ENFORCES what the spec makes the client's job, so a client that sends
// the wrong headers fails here the way it would against a real server:
//   modern (2026-07-28): MCP-Protocol-Version / Mcp-Method / Mcp-Name must match
//     the body (else 400 + -32020), the `_meta` envelope must be present, there
//     is no initialize (→ 404 -32601), results carry resultType/ttlMs/cacheScope;
//   legacy (2025-11-25): a modern probe gets `legacyProbe` (default: what the
//     official SDK's stateful server answers — 400 + -32000), initialize mints an
//     Mcp-Session-Id that every later request must carry, notifications get 202.

export type FakeTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };
export type FakePage = { tools: (string | FakeTool)[]; nextCursor?: string | null };
export type FakeCall = { method: string; headers: Record<string, string>; body: Record<string, unknown> };

export type FakeServerOptions = {
  era: "modern" | "legacy";
  // The pages of tools/list, keyed by the cursor a request carries (START = none).
  pages?: Map<string | typeof START, FakePage>;
  tools?: (string | FakeTool)[];
  // tools/call → the result (a modern result gets resultType added when absent).
  call?: (name: string, args: unknown, call: FakeCall) => Record<string, unknown> | Promise<Record<string, unknown>>;
  sse?: boolean;
  legacyVersion?: string; // what initialize answers (default 2025-11-25)
  legacyProbe?: () => Response; // a legacy server's reply to server/discover
  expireSessionAfter?: number; // legacy: 404 the session after this many requests
};

export const START = Symbol("start");

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export function fakeMcpServer(opts: FakeServerOptions) {
  const calls: FakeCall[] = [];
  const pages = opts.pages ?? new Map<string | typeof START, FakePage>([[START, { tools: opts.tools ?? [] }]]);
  let session = 0;
  let sessionRequests = 0;
  const live = new Set<string>();

  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (!opts.sse || status !== 200) return Response.json(body, { status, headers });
    // A priming event (id + empty data), a comment, an unrelated notification,
    // then the response spread over several `data:` lines (pretty-printed JSON,
    // so the "\n" the client joins them with falls where JSON allows whitespace)
    // — all of which a client must handle.
    const lines = JSON.stringify(body, null, 1).split("\n").map((l) => `data: ${l}`).join("\n");
    const stream = `id: 0\ndata:\n\n: keep-alive\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n${lines}\n\n`;
    return new Response(stream, { status, headers: { ...headers, "content-type": "text/event-stream" } });
  };

  const toolsPage = (cursor: string | typeof START) => {
    const page = pages.get(cursor);
    if (!page) return undefined;
    const tools = page.tools.map((t) => (typeof t === "string" ? { name: t, inputSchema: { type: "object", properties: {} } } : { inputSchema: { type: "object", properties: {} }, ...t }));
    return { tools, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
  };

  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body)) as { id?: unknown; method: string; params?: Record<string, unknown> };
    const call: FakeCall = { method: body.method, headers, body: body as Record<string, unknown> };
    calls.push(call);
    const { id, method } = body;
    const params = body.params ?? {};
    const meta = (params._meta ?? {}) as Record<string, unknown>;

    if (opts.era === "modern") {
      const version = meta["io.modelcontextprotocol/protocolVersion"];
      if (typeof version !== "string" || typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object") {
        return send(400, failure(id, -32602, "missing _meta envelope"));
      }
      if (version !== "2026-07-28") return send(400, failure(id, -32022, "Unsupported protocol version", { supported: ["2026-07-28"], requested: version }));
      if (headers["mcp-protocol-version"] !== version) return send(400, failure(id, -32020, "Header mismatch: MCP-Protocol-Version"));
      if (headers["mcp-method"] !== method) return send(400, failure(id, -32020, "Header mismatch: Mcp-Method"));
      if (method === "tools/call" && headers["mcp-name"] === undefined) return send(400, failure(id, -32020, "Header mismatch: Mcp-Name missing"));
      const ok = (result: Record<string, unknown>) => send(200, reply(id, { resultType: "complete", ...result }));
      if (method === "server/discover") return ok({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "public" });
      if (method === "tools/list") {
        const page = toolsPage("cursor" in params ? (params.cursor as string) : START);
        return page ? ok({ ...page, ttlMs: 0, cacheScope: "public" }) : send(200, failure(id, -32602, `invalid cursor ${String(params.cursor)}`));
      }
      if (method === "tools/call") {
        const result = await (opts.call ?? ((n) => ({ content: [{ type: "text", text: JSON.stringify({ ran: n }) }] })))(params.name as string, params.arguments, call);
        return send(200, reply(id, { resultType: "complete", ...result }));
      }
      return send(404, failure(id, -32601, `Method not found: ${method}`));
    }

    // legacy
    if (method === "server/discover") return opts.legacyProbe ? opts.legacyProbe() : Response.json(failure(id, -32000, "Bad Request: Server not initialized"), { status: 400 });
    if (method === "initialize") {
      const sid = `sess-${++session}`;
      live.add(sid);
      sessionRequests = 0;
      return send(200, reply(id, { protocolVersion: opts.legacyVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }), { "mcp-session-id": sid });
    }
    const sid = headers["mcp-session-id"];
    if (!sid) return Response.json(failure(null, -32000, "Bad Request: Mcp-Session-Id header is required"), { status: 400 });
    if (!live.has(sid)) return Response.json(failure(null, -32001, "Session not found"), { status: 404 });
    if ((opts.legacyVersion ?? "2025-11-25") >= "2025-06-18" && headers["mcp-protocol-version"] !== (opts.legacyVersion ?? "2025-11-25")) {
      return Response.json(failure(null, -32000, "Bad Request: MCP-Protocol-Version missing or wrong"), { status: 400 });
    }
    if (id === undefined) return new Response(null, { status: 202 }); // notification
    if (opts.expireSessionAfter !== undefined && ++sessionRequests > opts.expireSessionAfter) {
      live.delete(sid);
      return Response.json(failure(null, -32001, "Session not found"), { status: 404 });
    }
    if (method === "tools/list") {
      const page = toolsPage("cursor" in params ? (params.cursor as string) : START);
      return page ? send(200, reply(id, page)) : send(200, failure(id, -32602, `invalid cursor ${String(params.cursor)}`));
    }
    if (method === "tools/call") {
      const result = await (opts.call ?? ((n) => ({ content: [{ type: "text", text: JSON.stringify({ ran: n }) }] })))(params.name as string, params.arguments, call);
      return send(200, reply(id, result));
    }
    return send(200, failure(id, -32601, `Method not found: ${method}`));
  }) as typeof globalThis.fetch;

  return { fetch, calls, install: () => (globalThis.fetch = fetch) };
}
