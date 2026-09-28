// Step 4: the durable agent surface folded into the shared render pipeline
// (createPipeline — dev + worker). Proves the chat endpoint mounts and runs a
// turn, and that a non-agent path falls through to the router.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ACTION_REGISTRY } from "@junejs/core/agent";
import { resolveAgent } from "@junejs/core/config";
import { buildLinkHeader } from "@junejs/core/discovery";
import { route } from "@junejs/core/route";
import type { DocumentConfig } from "@junejs/core/document";
import type { Model, ModelReply } from "@junejs/core/agent-runtime";
import { replyStream } from "@junejs/core/agent-runtime";

import { createPipeline, type MiddlewareHandler, type RouteResolver } from "../src/pipeline";
import { discoverAgent } from "../src/agent-discover";
import { createAgentRuntime, mountAgent } from "../src/agent-native";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-ops");
const docConfig: DocumentConfig = { site: { name: "T" }, speculationRules: null, speculationDelivery: "inline", viewTransitions: false };

let pre = new Map(ACTION_REGISTRY);
beforeEach(() => { pre = new Map(ACTION_REGISTRY); ACTION_REGISTRY.clear(); });
afterEach(() => { ACTION_REGISTRY.clear(); for (const [k, v] of pre) ACTION_REGISTRY.set(k, v); });

function scriptedModel(script: ModelReply[]): Model {
  return (msgs) => replyStream(script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!);
}

// A pipeline with the agent surface mounted from the fixture agent + a scripted
// model (memory backend), and a stub router that records the matched path.
async function makePipeline() {
  let matched: string | undefined;
  const resolve: RouteResolver = async (pathname) => {
    matched = pathname;
    return { def: route({ json: () => ({ ok: true }) }), params: {}, chain: [] };
  };
  const def = await discoverAgent(FIXTURE);
  const model = scriptedModel([
    { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
    { text: "Done — order placed.", toolCalls: [] },
  ]);
  const rt = await createAgentRuntime({ [def.name]: { model, tools: def.tools } }, { backend: "memory" });
  const mounted = mountAgent(def, rt, { chatPath: "/message", channels: true });
  const agentSurface: MiddlewareHandler = (req) => mounted.surface(req);
  const pipeline = createPipeline({ docConfig, agent: resolveAgent(undefined), agentSurface, routeList: () => [], resolve });
  return { matchedPath: () => matched, fetch: (r: Request) => pipeline.fetch(r) };
}

describe("durable agent surface in the pipeline", () => {
  test("POST <chat.path> runs a durable turn (never reaches the router)", async () => {
    const p = await makePipeline();
    const res = await p.fetch(new Request("http://x/message", { method: "POST", body: JSON.stringify({ message: "Order 3 widgets", session: "s1" }) }));
    expect(await res.json()).toEqual({ text: "Done — order placed." });
    expect(p.matchedPath()).toBeUndefined();
  });

  test("a non-agent path falls through to the router", async () => {
    const p = await makePipeline();
    const res = await p.fetch(new Request("http://x/thing.json"));
    expect(await res.json()).toEqual({ ok: true });
    expect(p.matchedPath()).toBe("/thing");
  });
});

// ── /mcp identity: cfg.identity feeds the ActionContext the gateway dispatches with ──
describe("/mcp mount identity (cfg.identity)", () => {
  const gatedId = "pipeline_gated_read";
  function mcpCall(id: number) {
    return new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: gatedId, arguments: {} } }),
    });
  }
  async function mcpPipeline(identity?: Parameters<typeof createPipeline>[0]["identity"]) {
    const { defineAction } = await import("@junejs/core/agent");
    defineAction({
      id: gatedId,
      description: "Tenant-scoped read",
      input: { type: "object", properties: {} },
      requiresPrincipal: true,
      run: (_i: unknown, ctx: { user?: { id: string } }) => ({ tenant: ctx.user?.id }),
    });
    const resolve: RouteResolver = async () => null;
    return createPipeline({ docConfig, agent: resolveAgent({ mcp: true }), routeList: () => [], resolve, identity });
  }

  test("with an identity resolver, a requiresPrincipal action runs as that user", async () => {
    const p = await mcpPipeline(() => ({ user: { id: "acme" } }));
    const json = (await (await p.fetch(mcpCall(1))).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(json.result.isError).toBeUndefined();
    expect(JSON.parse(json.result.content[0]!.text)).toEqual({ tenant: "acme" });
  });

  test("without a resolver the same call is rejected (anonymous stays fail-closed)", async () => {
    const p = await mcpPipeline(undefined);
    const json = (await (await p.fetch(mcpCall(2))).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0]!.text).toContain("requires an authenticated principal");
  });
});

// ── REST projection: POST /api/<id> + /openapi.json on the same pipeline ──
describe("/api/<action> + /openapi.json (agent.api)", () => {
  const gatedId = "pipeline_api_gated";
  function apiCall(path: string, body = "{}") {
    return new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  }
  async function apiPipeline(opts: { identity?: Parameters<typeof createPipeline>[0]["identity"]; api?: boolean } = {}) {
    const { defineAction } = await import("@junejs/core/agent");
    defineAction({
      id: gatedId,
      description: "Tenant-scoped read",
      input: { type: "object", properties: {} },
      requiresPrincipal: true,
      run: (_i: unknown, ctx: { user?: { id: string } }) => ({ tenant: ctx.user?.id }),
    });
    let matched: string | undefined;
    const resolve: RouteResolver = async (pathname) => {
      matched = pathname;
      return { def: route({ json: () => ({ route: pathname }) }), params: {}, chain: [] };
    };
    const agent = resolveAgent(opts.api === undefined ? undefined : { api: opts.api });
    const p = createPipeline({ docConfig, agent, routeList: () => [], resolve, identity: opts.identity });
    return { fetch: (r: Request) => p.fetch(r), matchedPath: () => matched };
  }

  test("POST /api/<id> dispatches with the cfg.identity principal (same as /mcp)", async () => {
    const p = await apiPipeline({ identity: () => ({ user: { id: "acme" } }) });
    const res = await p.fetch(apiCall(`/api/${gatedId}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: "acme" });
    expect(p.matchedPath()).toBeUndefined(); // never reached the router
  });

  test("anonymous → 401 structured JSON", async () => {
    const p = await apiPipeline();
    const res = await p.fetch(apiCall(`/api/${gatedId}`));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  test("an /api path that is not an action falls through to the app's routes", async () => {
    const p = await apiPipeline();
    const res = await p.fetch(new Request("http://x/api/health", { headers: { accept: "application/json" } }));
    expect(await res.json()).toEqual({ route: "/api/health" });
    expect(p.matchedPath()).toBe("/api/health");
  });

  test("GET /openapi.json describes the action", async () => {
    const p = await apiPipeline();
    const res = await p.fetch(new Request("http://x/openapi.json"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { info: { title: string }; servers: { url: string }[]; paths: Record<string, unknown> };
    expect(doc.info.title).toBe("T");
    expect(doc.servers).toEqual([{ url: "http://x" }]);
    expect(doc.paths).toHaveProperty(`/api/${gatedId}`);
    // served with the exact type the Link header advertises for it
    const advertised = (await p.fetch(new Request("http://x/openapi.json"))).headers.get("content-type");
    const { OPENAPI_MEDIA_TYPE } = await import("@junejs/core/api");
    expect(advertised).toBe(OPENAPI_MEDIA_TYPE);
    expect(buildLinkHeader(resolveAgent())).toContain(`</openapi.json>; rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`);
  });

  test("an action id with '/' owns only its encoded path; the app keeps its nested /api routes", async () => {
    const p = await apiPipeline();
    const { defineAction } = await import("@junejs/core/agent");
    defineAction({ id: "a/b", description: "Slash id", input: { type: "object", properties: {} }, run: () => ({ action: "a/b" }) });

    const encoded = await p.fetch(apiCall("/api/a%2Fb"));
    expect(await encoded.json()).toEqual({ action: "a/b" });

    const nested = await p.fetch(new Request("http://x/api/a/b", { headers: { accept: "application/json" } }));
    expect(await nested.json()).toEqual({ route: "/api/a/b" });
    expect(p.matchedPath()).toBe("/api/a/b");

    const other = await p.fetch(new Request("http://x/api/v1/users", { headers: { accept: "application/json" } }));
    expect(await other.json()).toEqual({ route: "/api/v1/users" });
  });

  test("HEAD /openapi.json: same status + headers as GET, no body", async () => {
    const p = await apiPipeline();
    const res = await p.fetch(new Request("http://x/openapi.json", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.body).toBeNull();
  });

  test("agent.api=false: no /openapi.json, and /api/<id> is left to the app", async () => {
    const p = await apiPipeline({ api: false, identity: () => ({ user: { id: "acme" } }) });
    await p.fetch(apiCall(`/api/${gatedId}`));
    expect(p.matchedPath()).toBe(`/api/${gatedId}`);
    await p.fetch(new Request("http://x/openapi.json"));
    expect(p.matchedPath()).toBe("/openapi");
  });
});

// ── the /api namespace: June's REST namespace answers misses as the API, after app routes ──
describe("/api namespace (unmatched paths, the index)", () => {
  type ErrorBody = { error: { code: string; message: string; hint?: string } };
  async function nsPipeline(opts: { api?: boolean; appRoutes?: string[] } = {}) {
    const { defineAction } = await import("@junejs/core/agent");
    defineAction({
      id: "search_site",
      description: "Search pages.",
      input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: () => [],
    });
    const appRoutes = new Set(opts.appRoutes ?? []);
    // only the listed paths are app routes; everything else is a routing miss
    const resolve: RouteResolver = async (pathname) =>
      appRoutes.has(pathname) ? { def: route({ json: () => ({ app: pathname }) }), params: {}, chain: [] } : null;
    const agent = resolveAgent(opts.api === undefined ? undefined : { api: opts.api });
    return createPipeline({ docConfig, agent, routeList: () => [], resolve });
  }
  const ACCEPTS = ["text/html", "application/json", "text/markdown", "*/*"];

  test("an unmatched /api path is a JSON 404 for GET and POST, whatever the Accept", async () => {
    const p = await nsPipeline();
    for (const path of ["/api/nope", "/api/v1", "/api/v1/users"]) {
      for (const accept of ACCEPTS) {
        for (const method of ["GET", "POST"]) {
          const res = await p.fetch(
            new Request(`http://x${path}`, {
              method,
              headers: { accept, "content-type": "application/json" },
              ...(method === "POST" ? { body: "{}" } : {}),
            }),
          );
          expect(res.status, `${method} ${path} ${accept}`).toBe(404);
          expect(res.headers.get("content-type")).toContain("application/json");
          const { error } = (await res.json()) as ErrorBody;
          expect(error.code).toBe("not_found");
          expect(error.hint).toContain("/openapi.json");
        }
      }
    }
    const head = await p.fetch(new Request("http://x/api/nope", { method: "HEAD" }));
    expect(head.status).toBe(404);
    expect(head.body).toBeNull();
  });

  test("an app route under /api always wins", async () => {
    const p = await nsPipeline({ appRoutes: ["/api/foo", "/api"] });
    const res = await p.fetch(new Request("http://x/api/foo", { headers: { accept: "application/json" } }));
    expect(await res.json()).toEqual({ app: "/api/foo" });
    // the app owns /api too → no June index there
    const root = await p.fetch(new Request("http://x/api", { headers: { accept: "application/json" } }));
    expect(await root.json()).toEqual({ app: "/api" });
  });

  test("GET /api (and /api/) with no app route is the API index; HEAD has no body; POST is 405", async () => {
    const p = await nsPipeline();
    for (const path of ["/api", "/api/"]) {
      const res = await p.fetch(new Request(`http://x${path}`, { headers: { accept: "text/html" } }));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("link")).toBe(`</openapi.json>; rel="service-desc"; type="application/json"`);
      const index = (await res.json()) as {
        openapi: string;
        actions: Array<{ id: string; method: string; path: string; description: string }>;
        errors: { codes: string[] };
      };
      expect(index.openapi).toBe("http://x/openapi.json");
      expect(index.actions).toEqual([
        { id: "search_site", method: "POST", path: "/api/search_site", description: "Search pages." },
      ]);
      expect(index.errors.codes).toContain("not_found");
    }
    const head = await p.fetch(new Request("http://x/api", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("link")).toContain("service-desc");
    expect(head.body).toBeNull();
    const post = await p.fetch(
      new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  test("agent.api off: /api is an ordinary path again (no index, no API errors)", async () => {
    const p = await nsPipeline({ api: false });
    const root = await p.fetch(new Request("http://x/api", { headers: { accept: "application/json" } }));
    expect(root.status).toBe(404);
    const body = (await root.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_found"); // the pipeline's generic JSON 404, not the API index
    expect(body).not.toHaveProperty("openapi");
    const html = await p.fetch(new Request("http://x/api/nope", { headers: { accept: "text/html" } }));
    expect(html.headers.get("content-type")).toContain("text/html");
  });

  test("a malformed percent-escape is a routing miss, not a crash (a resolver's URIError)", async () => {
    const { defineAction } = await import("@junejs/core/agent");
    defineAction({ id: "noop", description: "No-op.", input: { type: "object", properties: {} }, run: () => ({}) });
    // decodes like every real resolver does: a bad escape throws URIError
    const resolve: RouteResolver = async (pathname) => {
      const segs = pathname.split("/").filter(Boolean).map(decodeURIComponent);
      return segs.join("/") === "docs/a b" ? { def: route({ json: () => ({ ok: true }) }), params: {}, chain: [] } : null;
    };
    const p = createPipeline({ docConfig, agent: resolveAgent(), routeList: () => [], resolve });

    for (const method of ["GET", "POST"]) {
      const res = await p.fetch(
        new Request("http://x/api/%ZZ", {
          method,
          headers: { accept: "text/html", "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
      expect(res.status, method).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
    }
    const page = await p.fetch(new Request("http://x/docs/%ZZ", { headers: { accept: "text/html" } }));
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("text/html");
    // a valid escape still resolves
    const ok = await p.fetch(new Request("http://x/docs/a%20b", { headers: { accept: "application/json" } }));
    expect(await ok.json()).toEqual({ ok: true });
  });

  test("a resolver's own errors propagate — even a URIError on a valid path (e.g. a route module's init)", async () => {
    let calls = 0;
    const resolve: RouteResolver = async () => {
      calls++;
      throw new URIError("route module init failed");
    };
    const p = createPipeline({ docConfig, agent: resolveAgent(), routeList: () => [], resolve });
    // a decodable path reaches the resolver, and its URIError is NOT turned into a 404
    await expect(p.fetch(new Request("http://x/docs/a%20b"))).rejects.toThrow("route module init failed");
    expect(calls).toBe(1);
    // a malformed path never reaches the resolver: it is a miss before resolving
    const page = await p.fetch(new Request("http://x/docs/%ZZ", { headers: { accept: "text/html" } }));
    expect(page.status).toBe(404);
    const api = await p.fetch(new Request("http://x/api/%ZZ", { headers: { accept: "text/html" } }));
    expect(api.status).toBe(404);
    expect(((await api.json()) as ErrorBody).error.code).toBe("not_found");
    expect(calls).toBe(1);

    const other = createPipeline({
      docConfig,
      agent: resolveAgent(),
      routeList: () => [],
      resolve: async () => {
        throw new Error("resolver broke");
      },
    });
    await expect(other.fetch(new Request("http://x/docs/x"))).rejects.toThrow("resolver broke");
  });

  test("isDecodablePath: every segment must percent-decode", async () => {
    const { isDecodablePath } = await import("../src/pipeline");
    for (const ok of ["/", "/docs/a%20b", "/docs/agents%2Doverview", "/%E6%8E%92", "/a/b/c", "/100%25"]) {
      expect(isDecodablePath(ok), ok).toBe(true);
    }
    for (const bad of ["/%ZZ", "/docs/%ZZ", "/blog/%E0%A4%A", "/%", "/a/%E6%8E/b", "/api/%ZZ"]) {
      expect(isDecodablePath(bad), bad).toBe(false);
    }
  });

  test("outside /api nothing changes: an HTML 404 stays HTML", async () => {
    const p = await nsPipeline();
    const res = await p.fetch(new Request("http://x/apiary", { headers: { accept: "text/html" } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
