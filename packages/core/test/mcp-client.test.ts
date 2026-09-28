// mcp-client.test.ts — June's MCP client against both protocol eras.
//
// The fake server (./mcp-fake-server) enforces what the spec makes the client's
// job — the modern headers and `_meta` envelope, the legacy session and version
// header — so these tests fail if the client sends the wrong wire, not only if
// it parses the wrong answer. Expected wire values (header encodings, error
// codes) are the spec's own examples (2026-07-28 transports / versioning / MRTR).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY } from "@junejs/core/agent";
import { connectAll, defineMcpConnection } from "@junejs/core/connections";
import { McpClient, McpError } from "../src/mcp-client";
import { decodeHeaderValue, encodeHeaderValue, headerParams, headerParamValues, readSse, type JsonRpcMessage } from "../src/mcp-protocol";
import { fakeMcpServer, type FakeCall } from "./mcp-fake-server";

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

const client = (fetch: typeof globalThis.fetch, headers: Record<string, string> = {}) => new McpClient({ url: "https://mcp.test/mcp", headers: () => headers, fetch });
const methods = (calls: FakeCall[]) => calls.map((c) => c.method);

describe("era detection", () => {
  test("a modern server: server/discover → modern; no initialize, no session, every request carries the envelope + mirrored headers", async () => {
    const server = fakeMcpServer({ era: "modern", tools: ["get_weather"] });
    const c = client(server.fetch);
    await c.request("tools/list");
    await c.request("tools/call", { name: "get_weather", arguments: { city: "Oslo" } });
    expect(c.negotiated).toEqual({ kind: "modern", version: "2026-07-28" });
    expect(methods(server.calls)).toEqual(["server/discover", "tools/list", "tools/call"]);
    for (const call of server.calls) {
      expect(call.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(call.headers["mcp-method"]).toBe(call.method);
      expect(call.headers.accept).toBe("application/json, text/event-stream");
      expect(call.headers["mcp-session-id"]).toBeUndefined();
      expect((call.body.params as { _meta: Record<string, unknown> })._meta).toEqual({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "june", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      });
    }
    expect(server.calls[2]!.headers["mcp-name"]).toBe("get_weather");
  });

  test("a legacy server: the probe fails → initialize, initialized, then session + version header on every request, no envelope", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["a"] });
    const c = client(server.fetch);
    await c.request("tools/list");
    expect(c.negotiated).toEqual({ kind: "legacy", version: "2025-11-25" });
    expect(methods(server.calls)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    const [, init, initialized, list] = server.calls;
    expect(init!.body.params).toEqual({ protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "june", version: "0.0.0" } });
    expect(init!.headers["mcp-session-id"]).toBeUndefined();
    for (const call of [initialized!, list!]) {
      expect(call.headers["mcp-session-id"]).toBe("sess-1");
      expect(call.headers["mcp-protocol-version"]).toBe("2025-11-25");
      expect(call.headers["mcp-method"]).toBeUndefined();
    }
    expect(initialized!.body.id).toBeUndefined(); // a notification
    expect(list!.body.params).toEqual({});
  });

  // What real 2025-era servers answer a server/discover they don't know.
  const legacyProbes: [string, () => Response][] = [
    ["400 + -32000 (the official SDK's stateful server)", () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } }, { status: 400 })],
    ["200 + -32601 method not found", () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } })],
    ["200 with an unrecognised result ({})", () => Response.json({ jsonrpc: "2.0", id: 1, result: {} })],
    ["404 with a plain-text body", () => new Response("Not Found", { status: 404 })],
    ["405 with no body", () => new Response(null, { status: 405 })],
    ["400 + -32022 listing only legacy versions", () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2025-11-25"], requested: "2026-07-28" } } }, { status: 400 })],
  ];
  for (const [name, probe] of legacyProbes) {
    test(`probe answered with ${name} → legacy`, async () => {
      const server = fakeMcpServer({ era: "legacy", tools: ["a"], legacyProbe: probe });
      const c = client(server.fetch);
      await c.request("tools/list");
      expect(c.negotiated?.kind).toBe("legacy");
    });
  }

  const hardFailures: [string, () => Response, RegExp][] = [
    ["401", () => new Response("no", { status: 401 }), /refused \(401\).*credentials/],
    ["403", () => new Response("no", { status: 403 }), /refused \(403\)/],
    ["503", () => new Response("down", { status: 503 }), /failed \(503\)/],
    ["-32022 listing only a newer modern revision", () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2027-01-01"], requested: "2026-07-28" } } }, { status: 400 }), /supports 2027-01-01/],
  ];
  for (const [name, probe, message] of hardFailures) {
    test(`probe answered with ${name} is an error, never a downgrade to initialize`, async () => {
      const server = fakeMcpServer({ era: "legacy", legacyProbe: probe });
      const err = (await client(server.fetch).request("tools/list").catch((e) => e)) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.message).toMatch(message);
      expect(methods(server.calls)).toEqual(["server/discover"]);
    });
  }

  test("-32022 listing 2026-07-28 itself → re-probe once (the client SHOULD retry with a supported version)", async () => {
    let probes = 0;
    const server = fakeMcpServer({ era: "modern", tools: ["a"] });
    const fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const { method, id } = JSON.parse(String(init!.body));
      if (method === "server/discover" && ++probes === 1) {
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28"], requested: "2026-07-28" } } }, { status: 400 });
      }
      return server.fetch(u, init);
    }) as typeof globalThis.fetch;
    const c = client(fetch);
    await c.request("tools/list");
    expect(probes).toBe(2);
    expect(c.negotiated?.kind).toBe("modern");
  });

  test("a second such rejection is an error — never a downgrade", async () => {
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      const { id } = JSON.parse(String(init!.body));
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28"], requested: "2026-07-28" } } }, { status: 400 });
    }) as typeof globalThis.fetch;
    await expect(client(fetch).request("tools/list")).rejects.toThrow(/rejected 2026-07-28 twice/);
  });

  for (const type of ["application/json", "text/event-stream"]) {
    test(`a probe body that fails while READING (${type}, connection reset) is an error, not a downgrade`, async () => {
      const calls: string[] = [];
      const fetch = (async (_u: unknown, init?: RequestInit) => {
        calls.push(JSON.parse(String(init!.body)).method);
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.error(new TypeError("connection reset"));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": type } });
      }) as typeof globalThis.fetch;
      await expect(client(fetch).request("tools/list")).rejects.toThrow("connection reset");
      expect(calls).toEqual(["server/discover"]); // no initialize
    });
  }

  test("a network failure on the probe is an error, not a downgrade", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(client(fetch).request("tools/list")).rejects.toThrow("fetch failed");
  });

  test("concurrent first requests share one probe", async () => {
    const server = fakeMcpServer({ era: "modern", tools: ["a"] });
    const c = client(server.fetch);
    await Promise.all([c.request("tools/list"), c.request("tools/list"), c.request("tools/list")]);
    expect(methods(server.calls).filter((m) => m === "server/discover")).toHaveLength(1);
  });
});

describe("legacy era", () => {
  test("a server negotiating 2025-06-18 gets that version in the header", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["a"], legacyVersion: "2025-06-18" });
    const c = client(server.fetch);
    await c.request("tools/list");
    expect(c.negotiated?.version).toBe("2025-06-18");
    expect(server.calls.at(-1)!.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  test("2025-03-26 predates MCP-Protocol-Version: the header is not sent", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["a"], legacyVersion: "2025-03-26" });
    await client(server.fetch).request("tools/list");
    expect(server.calls.at(-1)!.headers["mcp-protocol-version"]).toBeUndefined();
  });

  test("a version June doesn't speak (2024-11-05) fails the handshake", async () => {
    const server = fakeMcpServer({ era: "legacy", legacyVersion: "2024-11-05" });
    await expect(client(server.fetch).request("tools/list")).rejects.toThrow(/negotiated protocol version "2024-11-05"/);
  });

  test("an expired session (404) starts a new one — without the old id — and retries once", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["a"], expireSessionAfter: 1 });
    const c = client(server.fetch);
    await c.request("tools/list");
    const result = await c.request("tools/list");
    expect(result.tools).toBeDefined();
    expect(methods(server.calls)).toEqual([
      "server/discover", "initialize", "notifications/initialized", "tools/list",
      "tools/list", "initialize", "notifications/initialized", "tools/list",
    ]);
    expect(server.calls[5]!.headers["mcp-session-id"]).toBeUndefined();
    expect(server.calls.at(-1)!.headers["mcp-session-id"]).toBe("sess-2");
  });
});

describe("responses: JSON and SSE, both eras", () => {
  for (const era of ["modern", "legacy"] as const) {
    test(`${era}: an SSE response (priming event, comment, a notification, multi-line data) yields the response`, async () => {
      const server = fakeMcpServer({ era, tools: ["a", "b"], sse: true });
      const c = client(server.fetch);
      const result = (await c.request("tools/list")) as { tools: { name: string }[] };
      expect(result.tools.map((t) => t.name)).toEqual(["a", "b"]);
    });
  }

  const modernThen = (reply: () => Response) =>
    (async (_u: unknown, init?: RequestInit) => {
      const { method, id } = JSON.parse(String(init!.body));
      if (method === "server/discover") return Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
      return reply();
    }) as typeof globalThis.fetch;

  for (const [name, headers] of [
    ["text/plain", { "content-type": "text/plain" }],
    ["text/html", { "content-type": "text/html" }],
    ["no Content-Type", {}],
  ] as const) {
    test(`a JSON body served as ${name} is not an MCP response`, async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      const res = () => new Response(new TextEncoder().encode(body), { headers });
      await expect(client(modernThen(res)).request("tools/list")).rejects.toThrow(/not application\/json or text\/event-stream/);
    });
  }

  test("media-type parameters and case don't matter (Application/JSON; charset=utf-8)", async () => {
    const res = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }), { headers: { "content-type": "Application/JSON; charset=utf-8" } });
    expect(await client(modernThen(res)).request("tools/list")).toEqual({ tools: [] });
  });

  test("a probe answered with a non-MCP media type is classified legacy, not an error", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["a"], legacyProbe: () => new Response('{"jsonrpc":"2.0","id":1,"result":{"supportedVersions":["2026-07-28"]}}', { headers: { "content-type": "text/plain" } }) });
    const c = client(server.fetch);
    await c.request("tools/list");
    expect(c.negotiated?.kind).toBe("legacy");
  });

  test("an SSE stream that ends without the response is an error", async () => {
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      const { method } = JSON.parse(String(init!.body));
      if (method === "server/discover") return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
      return new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    await expect(client(fetch).request("tools/list")).rejects.toThrow(/stream ended before the response/);
  });
});

describe("readSse (WHATWG event-stream rules)", () => {
  const stream = (chunks: (string | Uint8Array)[]) =>
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : c);
        ctrl.close();
      },
    });
  const isResponse = (m: JsonRpcMessage) => m.id === 7;

  test("CRLF split across chunks, a UTF-8 character split across chunks, a BOM, and `data:` without a space", async () => {
    const json = '{"jsonrpc":"2.0","id":7,"result":{"text":"世界"}}';
    const bytes = new TextEncoder().encode(`﻿data:${json}\r\n\r\n`);
    const cut = bytes.indexOf(0xe4) + 1; // inside the first CJK character
    const crlf = bytes.length - 3; // between \r and \n
    const msg = await readSse(stream([bytes.slice(0, cut), bytes.slice(cut, crlf), bytes.slice(crlf)]), isResponse);
    expect(msg).toEqual({ jsonrpc: "2.0", id: 7, result: { text: "世界" } });
  });

  test("lone-CR line ends work too", async () => {
    const msg = await readSse(stream(['data: {"jsonrpc":"2.0",\rdata: "id":7,"result":{}}\r\r']), isResponse);
    expect(msg).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  test("an event without its terminating blank line is discarded at end of stream", async () => {
    expect(await readSse(stream(['data: {"jsonrpc":"2.0","id":7,"result":{}}']), isResponse)).toBeUndefined();
  });
});

describe("header value encoding (spec 2026-07-28, Value Encoding — its own examples)", () => {
  const examples: [string, string][] = [
    ["us-west1", "us-west1"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
  ];
  for (const [value, encoded] of examples) {
    test(`${JSON.stringify(value)} → ${encoded}, and back`, () => {
      expect(encodeHeaderValue(value)).toBe(encoded);
      expect(decodeHeaderValue(encoded)).toBe(value);
    });
  }
  test("an empty value is encoded; an invalid sentinel payload decodes to undefined", () => {
    expect(encodeHeaderValue("")).toBe("=?base64??=");
    expect(decodeHeaderValue("=?base64?%%%?=")).toBeUndefined();
  });
  test("a non-ASCII tool name is sent as an encoded Mcp-Name", async () => {
    const server = fakeMcpServer({ era: "modern", tools: ["天気"] });
    await client(server.fetch).request("tools/call", { name: "天気", arguments: {} });
    expect(server.calls.at(-1)!.headers["mcp-name"]).toBe(encodeHeaderValue("天気"));
    expect(decodeHeaderValue(server.calls.at(-1)!.headers["mcp-name"]!)).toBe("天気");
  });
});

describe("x-mcp-header: tool parameters mirrored into Mcp-Param-* (modern)", () => {
  const sql = {
    name: "execute_sql",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "Region" },
        query: { type: "string" },
        opts: { type: "object", properties: { dry: { type: "boolean", "x-mcp-header": "Dry-Run" }, limit: { type: "integer", "x-mcp-header": "Limit" } } },
      },
    },
  };

  test("the spec's example: Mcp-Param-Region mirrors the argument; nested, boolean and integer values too; absent/null → omitted", async () => {
    const server = fakeMcpServer({ era: "modern", tools: [sql] });
    server.install();
    const { actions } = await connectAll([defineMcpConnection({ name: "db", url: "https://mcp.test/mcp" })]);
    await actions[0]!.run({ region: "us-west1", query: "SELECT 1", opts: { dry: true, limit: 5 } }, {} as never);
    const h = server.calls.at(-1)!.headers;
    expect(h["mcp-param-region"]).toBe("us-west1");
    expect(h["mcp-param-dry-run"]).toBe("true");
    expect(h["mcp-param-limit"]).toBe("5");
    await actions[0]!.run({ region: "東京", query: "x", opts: { dry: null } }, {} as never);
    const h2 = server.calls.at(-1)!.headers;
    expect(h2["mcp-param-region"]).toBe(encodeHeaderValue("東京"));
    expect(h2["mcp-param-dry-run"]).toBeUndefined();
    expect(h2["mcp-param-limit"]).toBeUndefined();
  });

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    ["on an array item", { type: "object", properties: { tags: { type: "array", items: { type: "string", "x-mcp-header": "Tag" } } } }, /not reachable/],
    ["inside oneOf", { type: "object", oneOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] }, /not reachable/],
    ["on a number", { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } }, /"number" property/],
    ["with a non-token name", { type: "object", properties: { a: { type: "string", "x-mcp-header": "Bad Name" } } }, /not a valid header token/],
    ["duplicated case-insensitively", { type: "object", properties: { a: { type: "string", "x-mcp-header": "Id" }, b: { type: "string", "x-mcp-header": "ID" } } }, /used twice/],
  ];
  for (const [name, schema, reason] of invalid) {
    test(`an annotation ${name} invalidates the tool: it is dropped with a warning, the others stay`, async () => {
      expect("error" in headerParams(schema) && headerParams(schema)).toMatchObject({ error: expect.stringMatching(reason) });
      fakeMcpServer({ era: "modern", tools: [{ name: "bad", inputSchema: schema }, "good"] }).install();
      const warn = console.warn;
      const warned: string[] = [];
      console.warn = (m: string) => void warned.push(m);
      try {
        const { actions } = await connectAll([defineMcpConnection({ name: "s", url: "https://mcp.test/mcp" })]);
        expect(actions.map((a) => a.id)).toEqual(["s__good"]);
        expect(warned[0]).toContain('dropping tool "bad"');
      } finally {
        console.warn = warn;
      }
    });
  }

  test("a value of the wrong type (or an unsafe integer) is refused before sending", () => {
    const found = headerParams(sql.inputSchema);
    if ("error" in found) throw new Error(found.error);
    expect(() => headerParamValues(found.params, { opts: { limit: 2 ** 53 } })).toThrow(/safe integer/);
    expect(() => headerParamValues(found.params, { region: 5 })).toThrow(/must be a string/);
  });

  test("a legacy server's annotations are not enforced (x-mcp-header is a 2026-07-28 feature)", async () => {
    fakeMcpServer({ era: "legacy", tools: [{ name: "odd", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } }] }).install();
    const { actions } = await connectAll([defineMcpConnection({ name: "s", url: "https://mcp.test/mcp" })]);
    expect(actions.map((a) => a.id)).toEqual(["s__odd"]);
  });
});

describe("modern results: resultType and multi-round-trip requests", () => {
  test("a requestState-only input_required is retried with a NEW id, echoing the state verbatim", async () => {
    let round = 0;
    const server = fakeMcpServer({
      era: "modern",
      tools: ["slow"],
      call: () => (++round === 1 ? { resultType: "input_required", requestState: "opaque/state==" } : { content: [{ type: "text", text: '"done"' }] }),
    });
    const result = await client(server.fetch).request("tools/call", { name: "slow", arguments: { a: 1 } });
    expect(result.content).toEqual([{ type: "text", text: '"done"' }]);
    const [first, retry] = server.calls.filter((c) => c.method === "tools/call");
    expect(retry!.body.id).not.toBe(first!.body.id);
    expect((retry!.body.params as Record<string, unknown>).requestState).toBe("opaque/state==");
    expect((first!.body.params as Record<string, unknown>).requestState).toBeUndefined();
  });

  test("input requests (elicitation…) are refused: June declares no client capabilities", async () => {
    const server = fakeMcpServer({ era: "modern", tools: ["ask"], call: () => ({ resultType: "input_required", inputRequests: { e1: { method: "elicitation/create" } } }) });
    const err = (await client(server.fetch).request("tools/call", { name: "ask", arguments: {} }).catch((e) => e)) as McpError;
    expect(err.code).toBe(-32021);
    expect(err.message).toContain("does not provide");
  });

  test("the input_required loop is bounded", async () => {
    const server = fakeMcpServer({ era: "modern", tools: ["loop"], call: () => ({ resultType: "input_required", requestState: "again" }) });
    await expect(client(server.fetch).request("tools/call", { name: "loop", arguments: {} })).rejects.toThrow(/after 3 rounds/);
  });

  test("an unrecognised resultType is invalid (spec MUST)", async () => {
    const server = fakeMcpServer({ era: "modern", tools: ["x"], call: () => ({ resultType: "later" }) });
    await expect(client(server.fetch).request("tools/call", { name: "x", arguments: {} })).rejects.toThrow(/unrecognised resultType "later"/);
  });

  test("a modern protocol error (HTTP 400 + JSON-RPC error) surfaces with its code", async () => {
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      const { method, id } = JSON.parse(String(init!.body));
      if (method === "server/discover") return Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch: Mcp-Name" } }, { status: 400 });
    }) as typeof globalThis.fetch;
    const err = (await client(fetch).request("tools/call", { name: "x", arguments: {} }).catch((e) => e)) as McpError;
    expect(err.code).toBe(-32020);
    expect(err.status).toBe(400);
  });
});

describe("tools/call results as action results", () => {
  for (const era of ["modern", "legacy"] as const) {
    test(`${era}: isError is thrown (the model sees a failed call), structuredContent is preferred over text`, async () => {
      fakeMcpServer({
        era,
        tools: ["fails", "typed", "plain"],
        call: (name) =>
          name === "fails"
            ? { content: [{ type: "text", text: "quota exceeded" }], isError: true }
            : name === "typed"
              ? { content: [{ type: "text", text: '{"t":1}' }], structuredContent: { t: 1, unit: "C" } }
              : { content: [{ type: "text", text: "not json" }] },
      }).install();
      const { actions } = await connectAll([defineMcpConnection({ name: "s", url: "https://mcp.test/mcp" })]);
      const run = (id: string) => actions.find((a) => a.id === id)!.run({}, {} as never);
      await expect(run("s__fails")).rejects.toThrow("quota exceeded");
      expect(await run("s__typed")).toEqual({ t: 1, unit: "C" });
      expect(await run("s__plain")).toBe("not json");
    });
  }
});

describe("review round 3: sessions per credential, DiscoverResult shape, broken streams, server requests", () => {
  test("legacy sessions are per credential: each tenant opens its own, never discovery's; a tenant reuses its own", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["whoami"] });
    server.install();
    const { actions } = await connectAll([
      defineMcpConnection({
        name: "s",
        url: "https://mcp.test/mcp",
        auth: (ctx) => ({ token: (ctx as { user?: { id: string } } | undefined)?.user?.id ?? "discovery" }),
      }),
    ]);
    const run = (tenant: string) => actions[0]!.run({}, { user: { id: tenant } } as never);
    await run("acme");
    await run("globex");
    await run("acme");
    const sessionOf = (auth: string) =>
      new Set(server.calls.filter((c) => c.method === "tools/call" && c.headers.authorization === `Bearer ${auth}`).map((c) => c.headers["mcp-session-id"]));
    const discovery = server.calls.find((c) => c.method === "tools/list")!.headers["mcp-session-id"];
    const acme = sessionOf("acme");
    const globex = sessionOf("globex");
    expect(acme.size).toBe(1); // reused across acme's two calls
    expect(globex.size).toBe(1);
    expect([...acme][0]).not.toBe([...globex][0]);
    expect([...acme][0]).not.toBe(discovery);
    // Every initialize carried the credential of the tenant it was for.
    expect(server.calls.filter((c) => c.method === "initialize").map((c) => c.headers.authorization)).toEqual(["Bearer discovery", "Bearer acme", "Bearer globex"]);
  });

  test("a failed handshake doesn't poison the credential: the next call retries it", async () => {
    let failNext = false;
    const server = fakeMcpServer({ era: "legacy", tools: ["a"] });
    const c = client((async (u: string | URL | Request, init?: RequestInit) => {
      const { method } = JSON.parse(String(init!.body));
      if (method === "initialize" && failNext) {
        failNext = false;
        return new Response("busy", { status: 503 });
      }
      return server.fetch(u, init);
    }) as typeof globalThis.fetch);
    await c.request("tools/list");
    failNext = true;
    const other = { headers: () => ({ authorization: "Bearer other" }) };
    await expect(c.request("tools/list", {}, other)).rejects.toThrow();
    expect((await c.request("tools/list", {}, other)).tools).toBeDefined();
  });

  const notDiscover: [string, unknown][] = [
    ["no capabilities", { supportedVersions: ["2026-07-28"] }],
    ["capabilities that aren't an object", { supportedVersions: ["2026-07-28"], capabilities: [] }],
    ["a non-string version", { supportedVersions: ["2026-07-28", 7], capabilities: {} }],
  ];
  for (const [name, result] of notDiscover) {
    test(`a probe result with ${name} is not a DiscoverResult → legacy`, async () => {
      const server = fakeMcpServer({ era: "legacy", tools: ["a"], legacyProbe: () => Response.json({ jsonrpc: "2.0", id: 1, result }) });
      const c = client(server.fetch);
      await c.request("tools/list");
      expect(c.negotiated?.kind).toBe("legacy");
    });
  }

  for (const [name, broken] of [
    ["ends before the response", () => new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', { headers: { "content-type": "text/event-stream" } })],
    [
      "resets mid-read",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode(": partial\n"));
              ctrl.error(new TypeError("connection reset"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ],
  ] as const) {
    test(`modern: an SSE response stream that ${name} is re-issued with a NEW id (spec MUST), bounded`, async () => {
      const server = fakeMcpServer({ era: "modern", tools: ["t"] });
      let breaks = 1;
      const fetch = (async (u: string | URL | Request, init?: RequestInit) => {
        const { method } = JSON.parse(String(init!.body));
        if (method === "tools/call" && breaks-- > 0) {
          server.calls.push({ method, headers: {}, body: JSON.parse(String(init!.body)) });
          return broken();
        }
        return server.fetch(u, init);
      }) as typeof globalThis.fetch;
      const result = await client(fetch).request("tools/call", { name: "t", arguments: {} });
      expect(result.content).toBeDefined();
      const ids = server.calls.filter((c) => c.method === "tools/call").map((c) => c.body.id);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);

      breaks = 99; // never recovers: 1 + 2 re-issues, then the error
      await expect(client(fetch).request("tools/call", { name: "t", arguments: {} })).rejects.toThrow(/response stream/);
    });
  }

  test("legacy: a ping on the SSE stream is answered — the server can wait for it without deadlocking — and other requests get -32601", async () => {
    const server = fakeMcpServer({ era: "legacy", tools: ["a"] });
    const replies: { jsonrpc?: string; id: unknown; result?: unknown; error?: { code: number; message: string } }[] = [];
    let pong!: () => void;
    const answered = new Promise<void>((r) => (pong = r));
    const fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (body.method === undefined && body.id !== undefined) {
        // The client's answer to a server request.
        replies.push(body);
        if (body.id === "srv-ping") pong();
        return new Response(null, { status: 202 });
      }
      if (body.method !== "tools/list" || !init!.headers || !new Headers(init!.headers).get("mcp-session-id")) return server.fetch(u, init);
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          ctrl.enqueue(enc.encode('data: {"jsonrpc":"2.0","id":"srv-sample","method":"sampling/createMessage","params":{}}\n\n'));
          ctrl.enqueue(enc.encode('data: {"jsonrpc":"2.0","id":"srv-ping","method":"ping"}\n\n'));
          await answered; // the server won't send the response until the ping is answered
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n\n`));
          ctrl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const result = await client(fetch).request("tools/list");
    expect(result).toEqual({ tools: [] });
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: "srv-sample", error: { code: -32601, message: "Method not found: sampling/createMessage (June's MCP client declares no capabilities)" } },
      { jsonrpc: "2.0", id: "srv-ping", result: {} },
    ]);
  });
});
