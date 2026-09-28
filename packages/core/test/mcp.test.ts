import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, actionDispatchCode, defineAction, invokeAction } from "@junejs/core/agent";
import { resolveAgent } from "@junejs/core/config";
import { fitCardText, mcpHandler, mcpServerIdentity } from "@junejs/core/mcp";
import { encodeHeaderValue } from "../src/mcp-protocol";

// Empty registry per test, restored after — see discovery.test.ts: a cleared
// registry cannot be repopulated by re-import (module cache), which breaks
// later test files.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  ACTION_REGISTRY.clear();
  for (const [id, action] of preexisting) ACTION_REGISTRY.set(id, action);
});

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

  test("initialize (legacy era) negotiates: a version June speaks is echoed, anything else gets the latest legacy one", async () => {
    for (const [requested, answered] of [
      ["2025-06-18", "2025-06-18"],
      ["2025-03-26", "2025-03-26"],
      ["2024-11-05", "2025-11-25"],
      [undefined, "2025-11-25"],
    ] as const) {
      const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: requested ? { protocolVersion: requested } : {} }));
      expect(((await res.json()) as any).result.protocolVersion).toBe(answered);
    }
  });

  test("initialize returns the protocol version and serverInfo", async () => {
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
    // Stateless: no session is minted.
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe("2025-11-25");
    // no config → identity from the request's host, never an anonymous "june"
    expect(json.result.serverInfo).toEqual({ name: "com.example/mcp", version: "0.0.0" });
    expect(typeof json.result.instructions).toBe("string");
  });

  test("initialize reports the identity the host passes (name, title, instructions)", async () => {
    defineAction({
      id: "search_site",
      description: "Search pages",
      input: { type: "object", properties: {} },
      run: () => [],
    });
    const server = mcpServerIdentity("https://june.build", {
      site: { name: "June — build agents into real apps", description: "The agent-native React framework." },
      agent: { discovery: true },
    });
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }), {}, server);
    const json = (await res.json()) as any;
    expect(json.result.serverInfo).toEqual({ name: "build.june/june", title: "June", version: "0.0.0" });
    const text = json.result.instructions as string;
    expect(text).toContain("The agent-native React framework.");
    expect(text).toContain("Tools: search_site.");
    expect(text).toContain("https://june.build/llms.txt");
    expect(text).toContain("Accept: text/markdown");
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
      input: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      run: (input) => ({ sum: input.a + input.b }),
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 } } }),
    );
    const json = (await res.json()) as any;
    expect(JSON.parse(json.result.content[0].text)).toEqual({ sum: 5 });
  });

  test("tools/call on an unknown tool → JSON-RPC -32602 naming the tool and the real ones", async () => {
    defineAction({ id: "add", description: "Add", input: { type: "object", properties: {} }, run: () => 0 });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } }),
    );
    const json = (await res.json()) as any;
    expect(json.result).toBeUndefined();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('"nope"');
    expect(json.error.data).toEqual({ tools: ["add"] });
  });

  test("a bare (description-less) action is not callable over /mcp — it isn't a listed tool", async () => {
    defineAction({ id: "internal", input: { type: "object", properties: {} }, run: () => "secret" } as any);
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "internal", arguments: {} } }),
    );
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  test("invalid arguments → isError with a structured invalid_input body", async () => {
    defineAction({
      id: "add",
      description: "Add two numbers",
      input: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      run: (input) => input,
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "add", arguments: {} } }),
    );
    const json = (await res.json()) as any;
    expect(json.result.isError).toBe(true);
    const body = JSON.parse(json.result.content[0].text);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.message).toContain('Invalid input for "add"');
    expect(body.error.hint).toContain("inputSchema");
  });

  test("an anonymous call to a requiresPrincipal tool → isError code unauthorized", async () => {
    defineAction({
      id: "mine",
      description: "My things",
      input: { type: "object", properties: {} },
      requiresPrincipal: true,
      run: () => [],
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mine", arguments: {} } }),
    );
    const body = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(body.error.code).toBe("unauthorized");
  });

  test("an action that throws → isError code execution_error with its message", async () => {
    defineAction({
      id: "boom",
      description: "Fails",
      input: { type: "object", properties: {} },
      run: () => {
        throw new Error("upstream down");
      },
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "boom", arguments: {} } }),
    );
    const json = (await res.json()) as any;
    expect(json.result.isError).toBe(true);
    expect(JSON.parse(json.result.content[0].text)).toEqual({
      error: { code: "execution_error", message: "upstream down" },
    });
  });

  test("an error the action throws keeps execution_error, whatever `code` it carries", async () => {
    defineAction({
      id: "net",
      description: "Calls upstream",
      input: { type: "object", properties: {} },
      run: () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    });
    defineAction({
      id: "spoof",
      description: "Throws a dispatch-looking code",
      input: { type: "object", properties: {} },
      run: () => {
        throw Object.assign(new Error("not a dispatch refusal"), { code: "invalid_input" });
      },
    });
    for (const name of ["net", "spoof"]) {
      const res = await mcpHandler(
        rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name, arguments: {} } }),
      );
      const body = JSON.parse(((await res.json()) as any).result.content[0].text);
      expect(body.error.code).toBe("execution_error");
      expect(body.error.hint).toBeUndefined();
    }
  });

  test("a nested invokeAction refusal that ESCAPES run() is the outer tool's execution_error", async () => {
    defineAction({
      id: "outer",
      description: "Calls a missing action and lets it throw",
      input: { type: "object", properties: {} },
      run: async () => invokeAction("missing", {}),
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "outer", arguments: {} } }),
    );
    const body = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(body.error).toEqual({ code: "execution_error", message: "Unknown action: missing" });
  });

  test("a nested refusal the action CATCHES keeps its dispatch code for the action to read", async () => {
    let seen: { code: string | undefined; error: unknown } | undefined;
    defineAction({
      id: "careful",
      description: "Calls a missing action and handles the refusal",
      input: { type: "object", properties: {} },
      run: async () => {
        try {
          return await invokeAction("missing", {});
        } catch (error) {
          seen = { code: actionDispatchCode(error), error };
          return { fallback: true };
        }
      },
    });
    const res = await mcpHandler(
      rpc({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "careful", arguments: {} } }),
    );
    expect(JSON.parse(((await res.json()) as any).result.content[0].text)).toEqual({ fallback: true });
    expect(seen?.code).toBe("unknown_action");
  });

  test("clearing the marker keeps the escaping error's identity (same object, class, code)", async () => {
    class UpstreamError extends Error {}
    const thrown = Object.assign(new UpstreamError("x"), { code: "ECONNRESET" });
    defineAction({ id: "inner", description: "i", input: { type: "object", properties: {} }, run: () => 1 });
    defineAction({
      id: "rethrows",
      description: "r",
      input: { type: "object", properties: {} },
      run: async () => {
        await invokeAction("inner", { extra: "not allowed?" }).catch(() => {});
        throw thrown;
      },
    });
    const caught = await invokeAction("rethrows", {}).catch((e) => e);
    expect(caught).toBe(thrown); // identity preserved for app code up the stack
    // and a nested refusal escaping directly: same object, now unmarked
    defineAction({
      id: "leaks",
      description: "l",
      input: { type: "object", properties: {} },
      run: async () => invokeAction("missing", {}),
    });
    const leaked = (await invokeAction("leaks", {}).catch((e) => e)) as Error & { code?: string };
    expect(leaked).toBeInstanceOf(Error);
    expect(leaked.code).toBe("unknown_action"); // the property an app may read stays
    expect(actionDispatchCode(leaked)).toBeUndefined(); // but it is no longer THIS dispatch's refusal
  });

  test("an empty batch [] → ONE -32600 error object with id null (JSON-RPC §6)", async () => {
    const res = await mcpHandler(rpc([]));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(Array.isArray(json)).toBe(false);
    expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  });

  test("a message without jsonrpc 2.0 or a string method → -32600 Invalid Request", async () => {
    const res = await mcpHandler(rpc({ id: 10, method: 42 }));
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });

  test("a malformed id-less message is not a notification → -32600 with id null, not a silent 202", async () => {
    const res = await mcpHandler(rpc({ method: 42 }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.id).toBeNull();
    expect(json.error.code).toBe(-32600);
    // an id that is neither string nor number is invalid too
    const bad = (await (await mcpHandler(rpc({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }))).json()) as any;
    expect(bad).toMatchObject({ id: null, error: { code: -32600 } });
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

describe("mcpHandler() — modern era (2026-07-28)", () => {
  // A modern request: the `_meta` envelope in the body AND the mirrored headers,
  // exactly as the spec's wire examples show them.
  const META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  function modern(method: string, params: Record<string, unknown> = {}, opts: { headers?: Record<string, string | null>; meta?: Record<string, unknown>; id?: number } = {}) {
    const name = method === "tools/call" ? (params.name as string) : undefined;
    const headers: Record<string, string | null> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {}),
      ...opts.headers,
    };
    return new Request("https://example.com/mcp", {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== null)) as Record<string, string>,
      body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method, params: { ...params, _meta: opts.meta ?? META } }),
    });
  }
  const tool = () =>
    defineAction({ id: "echo", description: "Echo", input: { type: "object", properties: { text: { type: "string" } } }, run: (i: { text?: string }) => ({ echoed: i.text ?? "" }) });

  test("server/discover advertises 2026-07-28, the tools capability, instructions, cache hints and serverInfo", async () => {
    const res = await mcpHandler(modern("server/discover"));
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as any;
    expect(result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "com.example/mcp", version: "0.0.0" } },
    });
    expect(typeof result.instructions).toBe("string");
  });

  test("tools/list carries resultType + ttlMs + cacheScope (CacheableResult)", async () => {
    tool();
    const { result } = (await (await mcpHandler(modern("tools/list"))).json()) as any;
    expect(result.resultType).toBe("complete");
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe("public");
  });

  test("tools/call runs under the injected ctx and answers resultType complete", async () => {
    tool();
    const res = await mcpHandler(modern("tools/call", { name: "echo", arguments: { text: "hi" } }), { user: { id: "u1" } });
    const { result } = (await res.json()) as any;
    expect(result.resultType).toBe("complete");
    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: "hi" });
  });

  test("an encoded Mcp-Name (non-ASCII tool id) is decoded before comparing", async () => {
    defineAction({ id: "天気", description: "Weather", input: { type: "object", properties: {} }, run: () => "sunny" });
    const res = await mcpHandler(modern("tools/call", { name: "天気", arguments: {} }, { headers: { "mcp-name": encodeHeaderValue("天気") } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.content[0].text).toBe('"sunny"');
  });

  const mismatches: [string, Record<string, string | null>][] = [
    ["MCP-Protocol-Version missing", { "mcp-protocol-version": null }],
    ["MCP-Protocol-Version disagreeing with _meta", { "mcp-protocol-version": "2027-01-01" }],
    ["Mcp-Method missing", { "mcp-method": null }],
    ["Mcp-Method disagreeing with the body", { "mcp-method": "tools/list" }],
    ["Mcp-Name missing on tools/call", { "mcp-name": null }],
    ["Mcp-Name naming another tool", { "mcp-name": "other" }],
    ["Mcp-Name with a broken Base64 sentinel", { "mcp-name": "=?base64?%%?=" }],
  ];
  for (const [name, headers] of mismatches) {
    test(`${name} → 400 + -32020 HeaderMismatch, and the tool does not run`, async () => {
      let ran = false;
      defineAction({ id: "echo", description: "Echo", input: { type: "object", properties: {} }, run: () => (ran = true) });
      const res = await mcpHandler(modern("tools/call", { name: "echo", arguments: {} }, { headers }));
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error.code).toBe(-32020);
      expect(json.id).toBe(1);
      expect(ran).toBe(false);
    });
  }

  test("an unsupported modern version → 400 + -32022 listing the modern versions (what server/discover advertises)", async () => {
    const res = await mcpHandler(modern("tools/list", {}, { meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2027-01-01" }, headers: { "mcp-protocol-version": "2027-01-01" } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toEqual({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2026-07-28"], requested: "2027-01-01" },
    });
  });

  test("header vs body is checked BEFORE version support: disagreeing versions are -32020, not -32022", async () => {
    const res = await mcpHandler(modern("tools/list", {}, { meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2027-01-01" } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32020);
  });

  test("a missing clientCapabilities → 400 + -32602", async () => {
    const res = await mcpHandler(modern("tools/list", {}, { meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  test("legacy-only methods (initialize, ping) and unknown ones → 404 + -32601", async () => {
    for (const method of ["initialize", "ping", "resources/list"]) {
      const res = await mcpHandler(modern(method));
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.code).toBe(-32601);
    }
  });

  test("an unknown tool stays an in-band -32602 (HTTP 200), as in the legacy era", async () => {
    const res = await mcpHandler(modern("tools/call", { name: "nope", arguments: {} }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  test("a modern MCP-Protocol-Version header without the body envelope → 400 + -32602, not legacy", async () => {
    const res = await mcpHandler(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  test("the legacy era still works on the same endpoint, with the version header or without", async () => {
    tool();
    for (const headers of [{}, { "mcp-protocol-version": "2025-11-25" }, { "mcp-protocol-version": "2025-06-18" }] as Record<string, string>[]) {
      const res = await mcpHandler(
        new Request("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      );
      const json = (await res.json()) as any;
      expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
      expect(json.result.resultType).toBeUndefined(); // legacy results have no resultType
    }
  });

  test("a legacy request with an unsupported MCP-Protocol-Version → 400", async () => {
    const res = await mcpHandler(
      new Request("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2024-11-05" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
    );
    expect(res.status).toBe(400);
  });

  for (const [name, id] of [["null", null], ["an object", { a: 1 }], ["a boolean", true], ["a fractional number", 1.5]] as const) {
    test(`a request id that is ${name} → 400 + -32600 with a null error id (ids are strings or integers)`, async () => {
      const res = await mcpHandler(
        new Request("https://example.com/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: META } }),
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error.code).toBe(-32600);
      expect(json.id).toBeNull();
    });
  }

  test("string ids are accepted", async () => {
    const req = modern("tools/list");
    const body = JSON.parse(await req.text());
    const res = await mcpHandler(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify({ ...body, id: "req-7" }) }));
    expect(((await res.json()) as any).id).toBe("req-7");
  });

  test("validation order follows the official SDK: a PRESENT disagreeing Mcp-Method beats an unsupported version (-32020)…", async () => {
    const res = await mcpHandler(
      modern("tools/list", {}, { meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2027-01-01" }, headers: { "mcp-protocol-version": "2027-01-01", "mcp-method": "tools/call" } }),
    );
    expect(((await res.json()) as any).error.code).toBe(-32020);
  });

  test("…while a MISSING header is checked after version support (-32022), as the SDK's serveModern does", async () => {
    const res = await mcpHandler(
      modern("tools/list", {}, { meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2027-01-01" }, headers: { "mcp-protocol-version": "2027-01-01", "mcp-method": null } }),
    );
    expect(((await res.json()) as any).error.code).toBe(-32022);
  });

  test("a notification is exempt from the required-header checks (202)", async () => {
    const res = await mcpHandler(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever", params: { _meta: META } }),
      }),
    );
    expect(res.status).toBe(202);
  });

  describe("Mcp-Param-* on a re-served tool that declares x-mcp-header", () => {
    let ran: unknown[] = [];
    const sqlTool = () => {
      ran = [];
      defineAction({
        id: "execute_sql",
        description: "Execute SQL",
        // A connection tool re-served from a remote keeps the remote's schema, annotations included.
        input: {
          type: "object",
          properties: { region: { type: "string", "x-mcp-header": "Region" }, limit: { type: "integer", "x-mcp-header": "Limit" }, query: { type: "string" } },
        } as never,
        run: (i: unknown) => {
          ran.push(i);
          return "ok";
        },
      });
    };
    const call = (args: Record<string, unknown>, headers: Record<string, string | null>) => mcpHandler(modern("tools/call", { name: "execute_sql", arguments: args }, { headers }));

    test("matching headers (Base64-decoded, integers compared numerically) → the tool runs", async () => {
      sqlTool();
      const res = await call({ region: "東京", limit: 42, query: "select 1" }, { "mcp-param-region": encodeHeaderValue("東京"), "mcp-param-limit": "42.0" });
      expect(res.status).toBe(200);
      expect(ran).toHaveLength(1);
    });

    const bad: [string, Record<string, unknown>, Record<string, string | null>][] = [
      ["a missing header for a present argument", { region: "us-west1", query: "q" }, {}],
      ["a disagreeing value", { region: "us-west1", query: "q" }, { "mcp-param-region": "eu-west1" }],
      ["a header for an absent argument", { query: "q" }, { "mcp-param-region": "us-west1" }],
      ["a broken Base64 sentinel", { region: "x", query: "q" }, { "mcp-param-region": "=?base64?%%?=" }],
      ["a non-numeric integer header", { limit: 5, query: "q" }, { "mcp-param-limit": "five" }],
      // Outside the JS-safe range both sides round to 9007199254740992 and would
      // compare equal although they are different integers.
      ["an integer beyond the safe range", { limit: 9007199254740993, query: "q" }, { "mcp-param-limit": "9007199254740993" }],
      ["a header integer beyond the safe range for a safe body value", { limit: 5, query: "q" }, { "mcp-param-limit": "9007199254740993" }],
    ];
    for (const [name, args, headers] of bad) {
      test(`${name} → 400 + -32020, and the tool does not run`, async () => {
        sqlTool();
        const res = await call(args, headers);
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error.code).toBe(-32020);
        expect(ran).toHaveLength(0);
      });
    }

    test("an absent argument needs no header — the tool runs", async () => {
      sqlTool();
      const res = await call({ query: "q" }, {});
      expect(res.status).toBe(200);
      expect(ran).toHaveLength(1);
    });

    test("a null argument needs no header either (it passes the header check; the schema then judges it)", async () => {
      sqlTool();
      const res = await call({ region: null, query: "q" }, {});
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).error).toBeUndefined();
    });
  });

  test("a batch carrying MCP-Protocol-Version (2025-06-18+, which removed batching) → 400; without it (2025-03-26) it runs", async () => {
    tool();
    const batch = [{ jsonrpc: "2.0", id: 1, method: "tools/list" }];
    const withHeader = await mcpHandler(
      new Request("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(batch) }),
    );
    expect(withHeader.status).toBe(400);
    expect(((await withHeader.json()) as any).error.code).toBe(-32600);
    const without = await mcpHandler(rpc(batch));
    expect(Array.isArray(await without.json())).toBe(true);
  });

  test("a batch can't carry a modern request", async () => {
    const res = await mcpHandler(rpc([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });
});

describe("tools/list annotations", () => {
  test("an action's MCP ToolAnnotations are re-served to clients", async () => {
    defineAction({
      id: "delete_thing",
      description: "Removes a thing",
      input: { type: "object", properties: {} },
      annotations: { destructiveHint: true, idempotentHint: false },
      run: () => "gone",
    });
    const res = await mcpHandler(rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
    const json = (await res.json()) as { result: { tools: { name: string; annotations?: unknown }[] } };
    expect(json.result.tools.find((t) => t.name === "delete_thing")?.annotations).toEqual({ destructiveHint: true, idempotentHint: false });
  });
});

describe("mcpServerIdentity()", () => {
  test("name is reverse-DNS host / short-name slug; title is the short name", () => {
    const id = mcpServerIdentity("https://docs.acme.io", { site: { name: "Acme Docs | Guides" } });
    expect(id.name).toBe("io.acme.docs/acme-docs");
    expect(id.title).toBe("Acme Docs");
  });

  test("a name with no ASCII slug (CJK) falls back to <host>/mcp, keeping the real title", () => {
    const id = mcpServerIdentity("https://example.jp", { site: { name: "山田商店" } });
    expect(id.name).toBe("jp.example/mcp");
    expect(id.title).toBe("山田商店");
  });

  test("agent.mcpServer overrides every derived field; a bare name is namespaced by host", () => {
    const id = mcpServerIdentity("https://june.build", {
      site: { name: "June" },
      agent: {
        discovery: true,
        mcpServer: { name: "docs", title: "June Docs", version: "1.2.0", instructions: "Use search first." },
      },
    });
    expect(id).toMatchObject({ name: "build.june/docs", title: "June Docs", version: "1.2.0", instructions: "Use search first." });
    const qualified = mcpServerIdentity("https://june.build", { agent: { discovery: false, mcpServer: { name: "io.github.x/y" } } });
    expect(qualified.name).toBe("io.github.x/y");
  });

  test("a long site description is fitted to the card's 100 chars; instructions keep it whole", () => {
    const long =
      "The React framework where an agent is a feature, not a separate runtime: " +
      "your server actions are its tools, every turn is durable, and routes also serve MCP.";
    const id = mcpServerIdentity("https://june.build", { site: { name: "June", description: long } });
    expect(Array.from(id.description!).length).toBeLessThanOrEqual(100);
    expect(id.description).toBe(
      "The React framework where an agent is a feature, not a separate runtime: your server actions are…",
    );
    expect(id.instructions).toContain(long);
    // agent.mcpServer.description wins over the derived one-liner
    const over = mcpServerIdentity("https://june.build", {
      site: { description: long },
      agent: { discovery: false, mcpServer: { description: "Agent-native React." } },
    });
    expect(over.description).toBe("Agent-native React.");
  });

  test("the derived name always matches the v1 pattern — IPv6, ports, long titles", () => {
    const pattern = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
    for (const [origin, name] of [
      ["http://[::1]:8787", "App"],
      ["http://localhost:3000", "x".repeat(300)],
      ["https://example.com", "!!!"],
    ] as const) {
      const id = mcpServerIdentity(origin, { site: { name } });
      expect(id.name).toMatch(pattern);
      expect(id.name.length).toBeLessThanOrEqual(200);
      expect(Array.from(id.title!).length).toBeLessThanOrEqual(100);
    }
  });

  test("instructions only point at llms.txt / .md when the discovery surface is on", () => {
    const off = mcpServerIdentity("https://acme.com", { agent: { discovery: false } }).instructions;
    expect(off).not.toContain("llms.txt");
    expect(off).toContain("no tools");
  });
});

describe("fitCardText()", () => {
  test("short text passes through untouched", () => {
    expect(fitCardText("Agent-native React.")).toBe("Agent-native React.");
  });

  test("keeps whole sentences when a sentence ends in the back half", () => {
    const text = `${"a".repeat(60)}. ${"b".repeat(60)}.`;
    expect(fitCardText(text)).toBe(`${"a".repeat(60)}.`);
  });

  test("otherwise cuts at a word boundary with an ellipsis, dropping trailing punctuation", () => {
    const out = fitCardText(`${"word ".repeat(19)}tail, ${"more ".repeat(20)}`);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\s,]…$/);
    expect(Array.from(out).length).toBeLessThanOrEqual(100);
  });

  test("unbroken CJK text is cut at the limit (counting code points), or at 。", () => {
    const han = "漢".repeat(150);
    expect(fitCardText(han)).toBe(`${"漢".repeat(99)}…`);
    expect(fitCardText(`${"字".repeat(70)}。${"字".repeat(70)}`)).toBe(`${"字".repeat(70)}。`);
  });
});

describe("agent.mcpServer validation at config resolution", () => {
  test("a valid override resolves", () => {
    expect(resolveAgent({ mcpServer: { name: "io.github.acme/api", title: "Acme" } }).mcpServer?.name).toBe(
      "io.github.acme/api",
    );
    expect(resolveAgent({ mcpServer: { name: "docs" } }).mcpServer?.name).toBe("docs");
  });

  test.each([
    ["foo/bar/baz", "exactly one slash"],
    ["bad name/tool", "exactly one slash"],
    ["bad name", "bare name"],
    [`io.acme/${"x".repeat(200)}`, "at most 200"],
  ])("name %p is a config error", (name, message) => {
    expect(() => resolveAgent({ mcpServer: { name } })).toThrow(message);
    expect(() => resolveAgent({ mcpServer: { name } })).toThrow("agent.mcpServer.name");
  });

  test("title/description over the card's 100 chars (or empty) and an over-long version are config errors", () => {
    expect(() => resolveAgent({ mcpServer: { description: "d".repeat(101) } })).toThrow(
      "agent.mcpServer.description must be 1–100 characters",
    );
    expect(() => resolveAgent({ mcpServer: { title: "" } })).toThrow("agent.mcpServer.title");
    expect(() => resolveAgent({ mcpServer: { version: "v".repeat(256) } })).toThrow("agent.mcpServer.version");
  });

  test("lengths count code points like JSON Schema: 100 emoji is a valid title, 101 is not", () => {
    const emoji = "🚀".repeat(100); // 200 UTF-16 units, 100 code points
    expect(resolveAgent({ mcpServer: { title: emoji, description: emoji } }).mcpServer?.title).toBe(emoji);
    expect(() => resolveAgent({ mcpServer: { title: `${emoji}🚀` } })).toThrow("got 101");
    expect(resolveAgent({ mcpServer: { version: "🚀".repeat(255) } }).mcpServer?.version).toHaveLength(510);
    expect(() => resolveAgent({ mcpServer: { version: "🚀".repeat(256) } })).toThrow("agent.mcpServer.version");
  });
});
