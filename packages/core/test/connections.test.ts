// Connections consume an external MCP server or an OpenAPI service and turn each
// remote operation into a `<connection>__<tool>` defineAction. A mock global
// fetch stands in for the remotes; the assertions cover both protocols, that the
// produced tools actually CALL out, and that a down connection is reported (not
// thrown).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY } from "@junejs/core/agent";
import { connectAll, defineMcpConnection, defineOpenapiConnection } from "@junejs/core/connections";

// connectAll registers tools as defineActions (global registry) — isolate.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => { preexisting = new Map(ACTION_REGISTRY); ACTION_REGISTRY.clear(); });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; ACTION_REGISTRY.clear(); for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a); });

// A mock MCP server (/mcp), a mock OpenAPI doc (/openapi.json) + its op
// (/convert), and a host that refuses ("down").
function mockRemotes() {
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("down")) throw new Error("connection refused");
    if (u.endsWith("/mcp")) {
      const rpc = JSON.parse(init!.body!) as { id: unknown; method: string; params?: { arguments?: { city?: string } } };
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      if (rpc.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "weather", version: "1" } });
      if (rpc.method === "tools/list")
        return reply({ tools: [{ name: "get_weather", description: "Current weather", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] });
      if (rpc.method === "tools/call") {
        const city = rpc.params?.arguments?.city ?? "?";
        return reply({ content: [{ type: "text", text: JSON.stringify({ city, tempC: 21, sky: "clear" }) }] });
      }
      return reply({});
    }
    if (u.endsWith("/openapi.json"))
      return new Response(JSON.stringify({
        servers: [{ url: "http://fx.test" }],
        paths: { "/convert": { get: { operationId: "convert", summary: "Convert currency", parameters: [
          { name: "from", in: "query", required: true, schema: { type: "string" } },
          { name: "to", in: "query", required: true, schema: { type: "string" } },
          { name: "amount", in: "query", required: true, schema: { type: "number" } },
        ] } } },
      }));
    if (u.startsWith("http://fx.test/convert")) {
      const amount = Number(new URL(u).searchParams.get("amount"));
      return new Response(JSON.stringify({ converted: amount * 2 }));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("connectAll", () => {
  test("an MCP connection becomes a callable <name>__<tool> that calls out", async () => {
    mockRemotes();
    const { actions, report } = await connectAll([defineMcpConnection({ name: "weather", url: "http://x/mcp" })]);

    expect(report).toEqual([{ name: "weather", kind: "mcp", url: "http://x/mcp", tools: ["weather__get_weather"] }]);
    expect(actions.map((a) => a.id)).toEqual(["weather__get_weather"]);
    // the tool actually performs the tools/call round-trip and unwraps the text content
    expect(await actions[0]!.run({ city: "Taipei" }, {} as never)).toEqual({ city: "Taipei", tempC: 21, sky: "clear" });
  });

  test("an OpenAPI connection becomes a callable <name>__<operationId>", async () => {
    mockRemotes();
    const { actions, report } = await connectAll([defineOpenapiConnection({ name: "fx", url: "http://x/openapi.json" })]);

    expect(report[0]).toMatchObject({ name: "fx", kind: "openapi", tools: ["fx__convert"] });
    expect(actions[0]!.id).toBe("fx__convert");
    expect(await actions[0]!.run({ from: "USD", to: "TWD", amount: 10 }, {} as never)).toEqual({ converted: 20 });
  });

  test("connection tools are async ⇒ engine treats them as at-least-once remote", async () => {
    mockRemotes();
    const { actions } = await connectAll([defineMcpConnection({ name: "weather", url: "http://x/mcp" })]);
    expect(actions[0]!.run.constructor.name).toBe("AsyncFunction");
  });

  test("a down connection is reported with an error and does not throw", async () => {
    mockRemotes();
    const { actions, report } = await connectAll([
      defineMcpConnection({ name: "weather", url: "http://x/mcp" }),
      defineMcpConnection({ name: "broken", url: "http://down/mcp" }),
    ]);
    expect(actions.map((a) => a.id)).toEqual(["weather__get_weather"]); // the good one still connected
    expect(report.find((r) => r.name === "broken")).toMatchObject({ tools: [], error: expect.stringContaining("connection refused") });
  });
});
