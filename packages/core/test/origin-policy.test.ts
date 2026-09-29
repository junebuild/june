// Origin / Host validation on the agent endpoints (#308): CSRF and DNS rebinding.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { apiHandler } from "@junejs/core/api";
import { resolveAgent } from "@junejs/core/config";
import { mcpHandler, mcpServerIdentity, originRejection, type OriginPolicy } from "@junejs/core/mcp";

const req = (url: string, headers: Record<string, string> = {}, init: RequestInit = { method: "POST" }) =>
  new Request(url, { ...init, headers });

describe("originRejection", () => {
  test("no Origin passes: not a browser (CLI, SDK, server-side connector)", () => {
    expect(originRejection(req("https://example.com/mcp"))).toBeUndefined();
  });

  test("the request's own origin passes; any other is refused", () => {
    expect(originRejection(req("https://example.com/mcp", { origin: "https://example.com" }))).toBeUndefined();
    expect(originRejection(req("https://example.com/mcp", { origin: "https://evil.example" }))).toMatch(/Origin "https:\/\/evil.example" is not allowed.*agent.allowedOrigins/);
    // Scheme and port are part of the origin.
    expect(originRejection(req("https://example.com/mcp", { origin: "http://example.com" }))).toBeDefined();
    expect(originRejection(req("https://example.com/mcp", { origin: "https://example.com:8443" }))).toBeDefined();
    // Sandboxed iframes and file: pages send the opaque "null".
    expect(originRejection(req("https://example.com/mcp", { origin: "null" }))).toBeDefined();
  });

  test("allowedOrigins adds origins, compared as origins (trailing slash, default port, case)", () => {
    const policy: OriginPolicy = { allowedOrigins: ["https://App.example.com/", "http://localhost:5173"] };
    expect(originRejection(req("https://api.example.com/mcp", { origin: "https://app.example.com" }), policy)).toBeUndefined();
    expect(originRejection(req("https://api.example.com/mcp", { origin: "http://localhost:5173" }), policy)).toBeUndefined();
    expect(originRejection(req("https://api.example.com/mcp", { origin: "http://localhost:5174" }), policy)).toBeDefined();
  });

  test("DNS rebinding: same-origin by construction, so only allowedHosts catches it", () => {
    // The attacker's name now resolves to 127.0.0.1: Host and Origin both say evil.
    const rebound = req("http://evil.example.com:3000/mcp", { host: "evil.example.com:3000", origin: "http://evil.example.com:3000" });
    expect(originRejection(rebound)).toBeUndefined(); // an origin check alone lets it through
    const local: OriginPolicy = { allowedHosts: ["localhost", ".localhost"] };
    expect(originRejection(rebound, local)).toMatch(/Host "evil.example.com:3000" is not allowed.*agent.allowedHosts/);
  });

  test("allowedHosts: exact names, .suffix for subdomains, IP literals always, any port", () => {
    const policy: OriginPolicy = { allowedHosts: ["localhost", ".localhost", ".trycloudflare.com"] };
    const ok = (host: string) => originRejection(req(`http://${host}/mcp`, { host }), policy);
    for (const host of ["localhost:3000", "LOCALHOST", "app.localhost:3000", "abc.trycloudflare.com", "127.0.0.1:3000", "192.168.1.20:3000", "[::1]:3000"]) {
      expect(ok(host)).toBeUndefined();
    }
    for (const host of ["evil.example.com", "localhost.evil.com", "notlocalhost", "trycloudflare.com.evil.com"]) {
      expect(ok(host)).toBeDefined();
    }
  });
});

describe("the endpoints refuse with 403", () => {
  let preexisting = new Map(ACTION_REGISTRY);
  beforeEach(() => {
    preexisting = new Map(ACTION_REGISTRY);
    ACTION_REGISTRY.clear();
    defineAction({ id: "ping", description: "Ping.", input: { type: "object", properties: {} }, run: () => ({ pong: true }) });
  });
  afterEach(() => {
    ACTION_REGISTRY.clear();
    for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
  });

  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

  test("/mcp: a foreign Origin gets 403 and a JSON-RPC error with no id; the call never runs", async () => {
    const r = req("https://example.com/mcp", { origin: "https://evil.example", "content-type": "application/json" }, { method: "POST", body: list });
    const res = await mcpHandler(r, {}, mcpServerIdentity("https://example.com"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: expect.stringContaining('Origin "https://evil.example" is not allowed') } });
    expect("id" in body).toBe(false);
  });

  test("/mcp: the check runs before anything else — a GET from a refused Host is 403, not 405", async () => {
    const r = req("http://evil.example.com/mcp", { host: "evil.example.com" }, { method: "GET" });
    const res = await mcpHandler(r, {}, undefined, { allowedHosts: ["localhost"] });
    expect(res.status).toBe(403);
  });

  test("/mcp: allowed requests are served as before", async () => {
    const r = req("http://localhost:3000/mcp", { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, { method: "POST", body: list });
    const res = await mcpHandler(r, {}, undefined, { allowedHosts: ["localhost"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(["ping"]);
  });

  test("/api: a rebound Host gets 403 forbidden; the action never runs", async () => {
    let ran = false;
    ACTION_REGISTRY.clear();
    defineAction({ id: "ping", description: "Ping.", input: { type: "object", properties: {} }, run: () => ((ran = true), { pong: true }) });
    const r = req("http://evil.example.com:3000/api/ping", { host: "evil.example.com:3000", origin: "http://evil.example.com:3000", "content-type": "application/json" }, { method: "POST", body: "{}" });
    const res = await apiHandler(r, "ping", {}, { allowedHosts: ["localhost", ".localhost"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: expect.stringContaining("is not allowed") } });
    expect(ran).toBe(false);
  });
});

describe("CORS for an allowed origin", () => {
  let preexisting = new Map(ACTION_REGISTRY);
  beforeEach(() => {
    preexisting = new Map(ACTION_REGISTRY);
    ACTION_REGISTRY.clear();
    defineAction({ id: "ping", description: "Ping.", input: { type: "object", properties: {} }, run: () => ({ pong: true }) });
  });
  afterEach(() => {
    ACTION_REGISTRY.clear();
    for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
  });

  const policy: OriginPolicy = { allowedOrigins: ["https://app.example.com"] };
  const APP = "https://app.example.com";
  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

  for (const [name, call] of [
    ["/mcp", (r: Request) => mcpHandler(r, {}, undefined, policy)],
    ["/api", (r: Request) => apiHandler(r, "ping", {}, policy)],
  ] as const) {
    const url = `https://api.example.com${name === "/mcp" ? "/mcp" : "/api/ping"}`;

    test(`${name}: the preflight is answered — POST, the asked headers, credentials, Vary`, async () => {
      const res = await call(req(url, { origin: APP, "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version, mcp-param-region" }, { method: "OPTIONS" }));
      expect(res.status).toBe(204);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        "access-control-allow-origin": APP,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-param-region",
      });
      expect(res.headers.get("vary")).toContain("Origin");
    });

    test(`${name}: the response is readable by the allowed origin, and only by it`, async () => {
      const body = name === "/mcp" ? list : "{}";
      const ok = await call(req(url, { origin: APP, "content-type": "application/json" }, { method: "POST", body }));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
      expect(ok.headers.get("vary")).toContain("Origin");
      // Same-origin needs no CORS; a refused origin gets 403 without it.
      const own = await call(req(url, { origin: "https://api.example.com", "content-type": "application/json" }, { method: "POST", body }));
      expect(own.headers.get("access-control-allow-origin")).toBeNull();
      const evil = await call(req(url, { origin: "https://evil.example", "access-control-request-method": "POST" }, { method: "OPTIONS" }));
      expect(evil.status).toBe(403);
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    });
  }

  test("a preflight with no policy entry stays the old 405", async () => {
    const res = await mcpHandler(req("https://api.example.com/mcp", {}, { method: "OPTIONS" }));
    expect(res.status).toBe(405);
  });
});

describe("the published API contract lists the 403 (#308)", () => {
  test("GET /api's error codes and every OpenAPI operation", async () => {
    ACTION_REGISTRY.clear();
    defineAction({ id: "ping", description: "Ping.", input: { type: "object", properties: {} }, run: () => ({ pong: true }) });
    const { apiIndex, openApiDocument } = await import("@junejs/core/api");
    expect(apiIndex("https://example.com").errors.codes).toContain("forbidden");
    const doc = openApiDocument("https://example.com") as { paths: Record<string, { post: { responses: Record<string, unknown> } }> };
    expect(Object.keys(doc.paths["/api/ping"]!.post.responses)).toContain("403");
    ACTION_REGISTRY.clear();
  });
});

describe("config", () => {
  test("resolveAgent passes the allowlists through", () => {
    const agent = resolveAgent({ allowedOrigins: ["https://app.example.com"], allowedHosts: [".example.com"] });
    expect(agent.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(agent.allowedHosts).toEqual([".example.com"]);
  });

  test("a malformed entry fails when the config resolves, not per request", () => {
    expect(() => resolveAgent({ allowedOrigins: ["app.example.com"] })).toThrow(/allowedOrigins: "app.example.com" is not an origin/);
    expect(() => resolveAgent({ allowedOrigins: ["https://app.example.com/path"] })).toThrow(/is not an origin/);
    expect(() => resolveAgent({ allowedHosts: ["localhost:3000"] })).toThrow(/allowedHosts: "localhost:3000" is not a host name/);
    expect(() => resolveAgent({ allowedHosts: ["https://example.com"] })).toThrow(/is not a host name/);
    expect(() => resolveAgent({ allowedHosts: [""] })).toThrow(/is not a host name/);
  });
});
