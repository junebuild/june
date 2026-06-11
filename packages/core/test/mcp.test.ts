import { afterEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { mcpHandler } from "@junejs/core/mcp";

afterEach(() => ACTION_REGISTRY.clear());

function rpc(body: unknown): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mcpHandler()", () => {
  test("rejects non-POST with 405 + Allow", async () => {
    const res = await mcpHandler(new Request("https://example.com/mcp"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("initialize returns the protocol version and serverInfo", async () => {
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect(res.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("june");
  });

  test("tools/list surfaces only actions carrying a description", async () => {
    defineAction({
      id: "createUser",
      description: "Create a user",
      input: { type: "object", properties: { name: { type: "string" } } },
      run: () => ({}),
    });
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const json = (await res.json()) as any;
    expect(json.result.tools).toHaveLength(1);
    expect(json.result.tools[0]).toMatchObject({
      name: "createUser",
      description: "Create a user",
    });
  });

  test("tools/call runs the action under the injected ctx (scoped principal)", async () => {
    defineAction({
      id: "whoami",
      description: "Who am I",
      input: { type: "object", properties: {} },
      run: (_input, ctx) => ({ userId: ctx.user?.id ?? null }),
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "whoami", arguments: {} } }),
      { user: { id: "u42" } }, // the host (pipeline) injects this off the request
    );
    const json = (await res.json()) as any;
    expect(JSON.parse(json.result.content[0].text)).toEqual({ userId: "u42" });
  });

  test("tools/call dispatches through the registry", async () => {
    defineAction({
      id: "add",
      description: "Add two numbers",
      input: { type: "object", properties: {} },
      run: (input: { a: number; b: number }) => ({ sum: input.a + input.b }),
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 } } }),
    );
    const json = (await res.json()) as any;
    expect(JSON.parse(json.result.content[0].text)).toEqual({ sum: 5 });
  });

  test("tools/call on a bad tool reports isError without throwing the request", async () => {
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } }),
    );
    const json = (await res.json()) as any;
    expect(json.result.isError).toBe(true);
  });

  test("unknown method → JSON-RPC -32601", async () => {
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 5, method: "frobnicate" }));
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32601);
  });

  test("a notification (no id) gets a 202 with no body", async () => {
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", method: "initialized" }));
    expect(res.status).toBe(202);
  });
});
