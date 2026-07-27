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
        return reply({ tools: [{ name: "get_weather", description: "Current weather", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, annotations: { readOnlyHint: true } }] });
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

// ── connection identity: per-call auth ctx, requiresPrincipal, annotation fidelity ──
describe("connection identity + annotations", () => {
  test("auth receives the call's ActionContext (and none at discovery)", async () => {
    mockRemotes();
    // Wrap the mock to also record the Authorization header per request.
    const inner = globalThis.fetch;
    const sentAuth: (string | undefined)[] = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      sentAuth.push(init?.headers?.["authorization"]);
      return inner(url as string, init as RequestInit);
    }) as typeof fetch;

    const authCtxs: unknown[] = [];
    const { actions } = await connectAll([
      defineMcpConnection({
        name: "weather",
        url: "http://x/mcp",
        auth: (ctx) => {
          authCtxs.push(ctx);
          const user = (ctx as { user?: { id?: string } } | undefined)?.user;
          return { token: user?.id ? `tenant-${user.id}` : "svc" };
        },
      }),
    ]);
    // Discovery (initialize + tools/list) ran WITHOUT ctx → the service credential.
    expect(authCtxs).toEqual([undefined, undefined]);
    expect(sentAuth.slice(0, 2)).toEqual(["Bearer svc", "Bearer svc"]);

    // A call carrying identity mints the CALLER's credential.
    await actions[0]!.run({ city: "Taipei" }, { user: { id: "acme" } });
    expect(authCtxs[2]).toEqual({ user: { id: "acme" } });
    expect(sentAuth[2]).toBe("Bearer tenant-acme");
  });

  test("requiresPrincipal on the connection stamps every exposed action (mcp + openapi)", async () => {
    mockRemotes();
    const { actions } = await connectAll([
      defineMcpConnection({ name: "weather", url: "http://x/mcp", requiresPrincipal: true }),
      defineOpenapiConnection({ name: "fx", url: "http://x/openapi.json", requiresPrincipal: true }),
    ]);
    expect(actions.map((a) => a.requiresPrincipal)).toEqual([true, true]);
  });

  test("a remote MCP tool's annotations survive into the action (gateway fidelity)", async () => {
    mockRemotes();
    const { actions } = await connectAll([defineMcpConnection({ name: "weather", url: "http://x/mcp" })]);
    expect(actions[0]!.annotations).toEqual({ readOnlyHint: true });
  });
});
