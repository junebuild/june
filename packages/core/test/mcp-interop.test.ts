// mcp-interop.test.ts — June's MCP client and server against the OFFICIAL MCP
// TypeScript SDK v2 (@modelcontextprotocol/client + server 2.1.0), in-process:
// the SDK's client transport takes a `fetch`, and its handlers are
// Request → Response, so no port is opened.
//
// Both directions, both protocol eras:
//   SDK client (default legacy mode / auto probe / pinned 2026-07-28) → June's mcpHandler
//   June's client → SDK dual-era handler, modern-only handler, and a SESSIONFUL
//     legacy transport (which answers over SSE — the real wire, not our fake's).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { connectAll, defineMcpConnection } from "@junejs/core/connections";
import { mcpHandler } from "@junejs/core/mcp";
import { McpClient } from "../src/mcp-client";

let preexisting = new Map(ACTION_REGISTRY);
const realFetch = globalThis.fetch;
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  ACTION_REGISTRY.clear();
  for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
});

// --- SDK client → June server -------------------------------------------------------

function juneTools() {
  defineAction({
    id: "add",
    description: "Add two integers",
    input: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] },
    run: (i: { a: number; b: number }) => ({ sum: i.a + i.b }),
  });
  defineAction({
    id: "explode",
    description: "Always fails",
    input: { type: "object", properties: {} },
    run: () => {
      throw new Error("kaboom");
    },
  });
}

const modes = [
  ["default (legacy handshake)", undefined, "2025-11-25"],
  ["auto (server/discover probe)", { mode: "auto" as const }, "2026-07-28"],
  ["pinned 2026-07-28", { mode: { pin: "2026-07-28" } }, "2026-07-28"],
] as const;

describe("official SDK v2 client → June's /mcp", () => {
  for (const [name, versionNegotiation, expected] of modes) {
    test(`${name}: negotiates ${expected}, lists and calls June's tools, sees isError`, async () => {
      juneTools();
      const transport = new StreamableHTTPClientTransport(new URL("https://june.test/mcp"), {
        fetch: (url, init) => mcpHandler(new Request(url, init), {}),
      });
      const client = new Client({ name: "sdk-interop", version: "1.0.0" }, versionNegotiation ? { versionNegotiation } : {});
      await client.connect(transport);
      try {
        expect(client.getNegotiatedProtocolVersion()).toBe(expected);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(["add", "explode"]);
        const ok = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
        expect(ok.isError ?? false).toBe(false);
        expect(JSON.parse((ok.content as { type: string; text: string }[])[0]!.text)).toEqual({ sum: 5 });
        const failed = await client.callTool({ name: "explode", arguments: {} });
        expect(failed.isError).toBe(true);
        expect((failed.content as { text: string }[])[0]!.text).toContain("kaboom");
      } finally {
        await client.close();
      }
    });
  }
});

// --- June client → SDK servers -------------------------------------------------------

function sdkServer() {
  const server = new McpServer({ name: "sdk-server", version: "1.0.0" });
  server.registerTool(
    "weather.lookup", // a dotted name, as MCP allows — June reduces the id, calls by this name
    { description: "Weather for a city", inputSchema: z.object({ city: z.string() }), outputSchema: z.object({ city: z.string(), tempC: z.number() }) },
    async ({ city }) => ({ content: [{ type: "text", text: JSON.stringify({ city, tempC: 21 }) }], structuredContent: { city, tempC: 21 } }),
  );
  server.registerTool("fails", { description: "Always fails", inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "quota exceeded" }],
    isError: true,
  }));
  return server;
}

// A sessionful 2025 deployment: one transport per session, SSE responses (the
// transport's default), a 404 for an unknown session.
function sessionfulLegacyServer() {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let minted = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(url, init);
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const t = sessions.get(sid);
      return t ? t.handleRequest(req) : Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }, { status: 404 });
    }
    const body = await req.clone().json().catch(() => undefined);
    if (body?.method !== "initialize") {
      // What the SDK's stateful legacy server answers to anything before initialize —
      // including a modern server/discover probe.
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } }, { status: 400 });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${++minted}`,
      onsessioninitialized: (id) => void sessions.set(id, transport),
    });
    await sdkServer().connect(transport);
    return transport.handleRequest(req);
  };
  return { fetch, sessions };
}

const juneConnection = () => connectAll([defineMcpConnection({ name: "sdk", url: "https://sdk.test/mcp" })]);

async function exerciseTools(actions: Awaited<ReturnType<typeof juneConnection>>["actions"]) {
  expect(actions.map((a) => a.id).sort()).toEqual(["sdk__fails", "sdk__weather_lookup"]);
  const weather = actions.find((a) => a.id === "sdk__weather_lookup")!;
  expect(await weather.run({ city: "Oslo" }, {} as never)).toEqual({ city: "Oslo", tempC: 21 });
  await expect(actions.find((a) => a.id === "sdk__fails")!.run({}, {} as never)).rejects.toThrow("quota exceeded");
}

describe("June's client → official SDK v2 servers", () => {
  test("the SDK's default dual-era handler: June negotiates 2026-07-28 and calls tools (dotted name, structuredContent, isError)", async () => {
    const handler = createMcpHandler(() => sdkServer());
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch;
    const { actions, report } = await juneConnection();
    expect(report[0]!.error).toBeUndefined();
    await exerciseTools(actions);

    const probe = new McpClient({ url: "https://sdk.test/mcp", headers: () => ({}), fetch: globalThis.fetch });
    expect(await probe.connect()).toEqual({ kind: "modern", version: "2026-07-28" });
  });

  test("a modern-only SDK handler (legacy: 'reject') works the same", async () => {
    const handler = createMcpHandler(() => sdkServer(), { legacy: "reject" });
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch;
    const { actions, report } = await juneConnection();
    expect(report[0]!.error).toBeUndefined();
    await exerciseTools(actions);
  });

  test("a SESSIONFUL legacy SDK server answering over SSE: June falls back, keeps the session, parses the real SSE", async () => {
    const server = sessionfulLegacyServer();
    const requests: { method: string; session: string | null; version: string | null; accept: string | null }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      const body = await req.clone().json();
      requests.push({ method: body.method, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version"), accept: req.headers.get("accept") });
      return server.fetch(req);
    }) as typeof fetch;

    const { actions, report } = await juneConnection();
    expect(report[0]!.error).toBeUndefined();
    await exerciseTools(actions);
    expect(server.sessions.size).toBe(1); // one handshake, reused for every call

    expect(requests.map((r) => r.method).slice(0, 4)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    for (const r of requests.slice(2)) {
      expect(r.session).toBe("session-1");
      expect(r.version).toBe("2025-11-25");
    }
    for (const r of requests) expect(r.accept).toBe("application/json, text/event-stream");
  });
});
