// Connections consume an external MCP server or an OpenAPI service and turn each
// remote operation into a `<connection>__<tool>` defineAction. A mock global
// fetch stands in for the remotes; the assertions cover both protocols, that the
// produced tools actually CALL out, and that a down connection is reported (not
// thrown).

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { connectAll, defineMcpConnection, defineOpenapiConnection, defineProviderConnection } from "@junejs/core/connections";
import { fakeMcpServer, START, type FakeCall, type FakePage } from "./mcp-fake-server";

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
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
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
    // Discovery (the era probe, the handshake, tools/list) ran WITHOUT ctx →
    // every one of those requests carried the service credential.
    expect(authCtxs.length).toBeGreaterThan(0);
    expect(authCtxs.every((c) => c === undefined)).toBe(true);
    const discovery = sentAuth.length;
    expect(sentAuth).toEqual(Array(discovery).fill("Bearer svc"));

    // A call carrying identity mints the CALLER's credential.
    await actions[0]!.run({ city: "Taipei" }, { user: { id: "acme" } });
    expect(authCtxs.at(-1)).toEqual({ user: { id: "acme" } });
    // This mock is a 2025-era server, so the tenant's call opens the tenant's
    // OWN session (initialize → initialized → call) — never the discovery one.
    expect(sentAuth.slice(discovery)).toEqual(["Bearer tenant-acme", "Bearer tenant-acme", "Bearer tenant-acme"]);
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

// ── provider connections: bring-your-own-transport, still in the lifecycle ──
describe("provider connections", () => {
  // A tiny provider that builds two tools (one sync, one async). It threads the
  // connect({ requiresPrincipal }) option into its defineActions — the gate must
  // be applied at REGISTRATION (so the Flight server reference is fail-closed too),
  // never retro-mutated by connectAll.
  const twoTools = (name = "prov", requiresPrincipal = false) => [
    defineAction({ id: `${name}__ping`, description: "ping", input: { type: "object", properties: {} } as const, ...(requiresPrincipal ? { requiresPrincipal } : {}), run: () => ({ pong: true }) }),
    defineAction({ id: `${name}__echo`, description: "echo", input: { type: "object", properties: { v: { type: "string" } } } as const, ...(requiresPrincipal ? { requiresPrincipal } : {}), run: async (i) => ({ v: i.v }) }),
  ];

  test("a provider connection contributes its tools and reports kind:provider", async () => {
    const { actions, report } = await connectAll([
      defineProviderConnection({ name: "prov", url: "https://api.example.com", connect: () => twoTools() }),
    ]);
    expect(actions.map((a) => a.id)).toEqual(["prov__ping", "prov__echo"]);
    expect(report).toEqual([{ name: "prov", kind: "provider", url: "https://api.example.com", tools: ["prov__ping", "prov__echo"] }]);
    // The produced tools are runnable through the same registry.
    expect(await actions[0]!.run({}, {} as never)).toEqual({ pong: true });
  });

  test("connect() may be async and receives the requiresPrincipal option (not identity)", async () => {
    const seen: unknown[] = [];
    const { actions } = await connectAll([
      defineProviderConnection({ name: "prov", connect: async (opts) => { seen.push(opts); return twoTools(); } }),
    ]);
    expect(seen).toEqual([{ requiresPrincipal: undefined }]); // discovery: the gate option, no principal
    expect(actions).toHaveLength(2);
  });

  test("a provider with no url gets a synthetic report url", async () => {
    const { report } = await connectAll([defineProviderConnection({ name: "prov", connect: () => twoTools() })]);
    expect(report[0]).toMatchObject({ name: "prov", kind: "provider", url: "provider:prov" });
  });

  test("a throwing provider is reported with an error and does not take others down", async () => {
    const { actions, report } = await connectAll([
      defineProviderConnection({ name: "good", connect: () => twoTools("good") }),
      defineProviderConnection({ name: "bad", connect: () => { throw new Error("provider boom"); } }),
    ]);
    expect(actions.map((a) => a.id)).toEqual(["good__ping", "good__echo"]); // the good one still connected
    expect(report.find((r) => r.name === "bad")).toMatchObject({ tools: [], error: expect.stringContaining("provider boom") });
  });

  test("requiresPrincipal is passed into connect so the provider gates its tools at registration", async () => {
    const { actions } = await connectAll([
      defineProviderConnection({ name: "prov", requiresPrincipal: true, connect: (opts) => twoTools("prov", opts.requiresPrincipal) }),
    ]);
    expect(actions.every((a) => a.requiresPrincipal === true)).toBe(true);
  });

  test("a non-compliant provider (ignores the gate) fails fast AND leaves nothing registered", async () => {
    // The provider ignores opts.requiresPrincipal, so its tools are NOT gated.
    // connectAll must reject (reported error), never retro-mutate the flag —
    // which would leave the Flight server-reference path open — AND must roll the
    // ungated tools back out of the global registry (/mcp, invokeAction).
    const { actions, report } = await connectAll([
      defineProviderConnection({ name: "leaky", requiresPrincipal: true, connect: () => twoTools("leaky", false) }),
    ]);
    expect(actions).toHaveLength(0);
    expect(report[0]).toMatchObject({ name: "leaky", tools: [], error: expect.stringContaining("was not built gated") });
    expect(ACTION_REGISTRY.has("leaky__ping")).toBe(false);
    expect(ACTION_REGISTRY.has("leaky__echo")).toBe(false);
  });

  test("a provider that throws AFTER registering some tools is rolled back (transactional)", async () => {
    const { actions, report } = await connectAll([
      defineProviderConnection({
        name: "half",
        connect: () => {
          twoTools("half"); // these self-register via defineAction…
          throw new Error("boom after register"); // …then the provider blows up
        },
      }),
    ]);
    expect(actions).toHaveLength(0);
    expect(report[0]).toMatchObject({ name: "half", error: expect.stringContaining("boom after register") });
    // Neither tool may remain reachable in the global registry.
    expect(ACTION_REGISTRY.has("half__ping")).toBe(false);
    expect(ACTION_REGISTRY.has("half__echo")).toBe(false);
  });

  test("a healthy connection alongside a failed one keeps ITS tools registered", async () => {
    const { report } = await connectAll([
      defineProviderConnection({ name: "ok", connect: () => twoTools("ok") }),
      defineProviderConnection({ name: "half", connect: () => { twoTools("half"); throw new Error("boom"); } }),
    ]);
    expect(report.find((r) => r.name === "ok")!.tools).toEqual(["ok__ping", "ok__echo"]);
    expect(ACTION_REGISTRY.has("ok__ping")).toBe(true); // survivor kept
    expect(ACTION_REGISTRY.has("half__ping")).toBe(false); // failure rolled back
  });

  test("rollback RESTORES a pre-existing action a failed connection overwrote", async () => {
    // A pre-existing (e.g. app) action under an id the failed connection reuses.
    const original = defineAction({ id: "shared__id", description: "original", input: { type: "object", properties: {} } as const, run: () => "original" });
    const { report } = await connectAll([
      defineProviderConnection({
        name: "clobber",
        connect: () => {
          defineAction({ id: "shared__id", description: "hijacked", input: { type: "object", properties: {} } as const, run: () => "hijacked" });
          throw new Error("boom after overwrite");
        },
      }),
    ]);
    expect(report[0]).toMatchObject({ name: "clobber", error: expect.stringContaining("boom after overwrite") });
    // The original must be restored — NOT left as the failed connection's action.
    expect(ACTION_REGISTRY.get("shared__id")).toBe(original);
    expect(await ACTION_REGISTRY.get("shared__id")!.run({}, {} as never)).toBe("original");
  });

  test("connectAll is serialized: a failing run can't roll back a concurrent run's tools", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // A registers its tool, awaits the gate, then FAILS.
    const aP = connectAll([
      defineProviderConnection({ name: "a", connect: async () => { const t = twoTools("a"); await gate; throw new Error("a fails"); } }),
    ]);
    await Promise.resolve(); // let A get a head start
    // B registers its own tools while A is pending.
    const bP = connectAll([defineProviderConnection({ name: "b", connect: () => twoTools("b") })]);
    release();
    await Promise.all([aP, bP]);
    // Serialization means A's snapshot-diff can never see (and delete) B's tools.
    expect(ACTION_REGISTRY.has("b__ping")).toBe(true);
    expect(ACTION_REGISTRY.has("a__ping")).toBe(false);
  });

  test("mixed kinds connect together into one report", async () => {
    mockRemotes();
    const { actions, report } = await connectAll([
      defineMcpConnection({ name: "weather", url: "http://x/mcp" }),
      defineProviderConnection({ name: "prov", connect: () => twoTools() }),
    ]);
    expect(actions.map((a) => a.id)).toEqual(["weather__get_weather", "prov__ping", "prov__echo"]);
    expect(report.map((r) => r.kind)).toEqual(["mcp", "provider"]);
  });
});

// --- OpenAPI connections against real-world descriptions (#245) ---------------

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

// Serve `docs` by URL; record every request; answer API calls with `api(url)`.
// Like real fetch, a 3xx is FOLLOWED unless `redirect: "manual"` — re-sending
// the same headers, custom ones included (only Authorization is special-cased
// by the Fetch spec) — so code relying on default redirects leaks exactly as
// it would in production.
function serveOpenapi(docs: Record<string, unknown | (() => Response)>, api: (call: Call) => Response = () => Response.json({ ok: true })) {
  const calls: Call[] = [];
  const fake = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    const doc = docs[call.url];
    const res = doc !== undefined ? (typeof doc === "function" ? (doc as () => Response)() : Response.json(doc)) : api(call);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && init?.redirect !== "manual") {
      return fake(new URL(location, call.url).href, init);
    }
    return res;
  }) as typeof fetch;
  globalThis.fetch = fake;
  return calls;
}
const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { location } });

const GITHUB_SLICE = JSON.parse(readFileSync(new URL("./fixtures/openapi/github-issues.json", import.meta.url), "utf8"));
const RAW = "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json";
const secretAuth = () => ({ token: "ghs_SECRET" });

describe("OpenAPI: credentials never go to the document host by default", () => {
  test("a document on another origin is fetched with no authorization and no connection headers", async () => {
    const calls = serveOpenapi({ [RAW]: GITHUB_SLICE });
    const { actions, report } = await connectAll([
      defineOpenapiConnection({ name: "gh", url: RAW, auth: secretAuth, headers: { "x-api-key": "k" } }),
    ]);
    expect(report[0]!.error).toBeUndefined();
    expect(calls[0]!.url).toBe(RAW);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    // …while the API call itself carries them.
    await actions.find((a) => a.id === "gh__issues_list-for-repo")!.run({ owner: "acme", repo: "widgets" } as never, {} as never);
    expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/widgets/issues");
    expect(calls[1]!.headers.authorization).toBe("Bearer ghs_SECRET");
    expect(calls[1]!.headers["x-api-key"]).toBe("k");
  });

  test("a document served by the API origin (baseUrl) gets the credentials", async () => {
    const calls = serveOpenapi({ "https://api.example.com/openapi.json": GITHUB_SLICE });
    await connectAll([defineOpenapiConnection({ name: "ex", url: "https://api.example.com/openapi.json", baseUrl: "https://api.example.com/v1", auth: secretAuth })]);
    expect(calls[0]!.headers.authorization).toBe("Bearer ghs_SECRET");
  });

  test("docAuth overrides the origin rule both ways", async () => {
    let calls = serveOpenapi({ [RAW]: GITHUB_SLICE });
    await connectAll([defineOpenapiConnection({ name: "a", url: RAW, auth: secretAuth, docAuth: true })]);
    expect(calls[0]!.headers.authorization).toBe("Bearer ghs_SECRET");
    calls = serveOpenapi({ "https://api.example.com/openapi.json": GITHUB_SLICE });
    await connectAll([
      defineOpenapiConnection({ name: "b", url: "https://api.example.com/openapi.json", baseUrl: "https://api.example.com", auth: secretAuth, docAuth: false }),
    ]);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  test("a credentialed document that redirects to another origin loses every credential header on that hop", async () => {
    const CDN = "https://cdn.example.net/openapi.json";
    const calls = serveOpenapi({ "https://api.example.com/openapi.json": redirectTo(CDN), [CDN]: GITHUB_SLICE });
    const { report } = await connectAll([
      defineOpenapiConnection({ name: "ex", url: "https://api.example.com/openapi.json", baseUrl: "https://api.example.com", auth: secretAuth, headers: { "x-api-key": "k" } }),
    ]);
    expect(report[0]!.error).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual(["https://api.example.com/openapi.json", CDN]);
    expect(calls[0]!.headers["x-api-key"]).toBe("k"); // the document's own origin: sent
    expect(calls[1]!.headers["x-api-key"]).toBeUndefined(); // the CDN: never
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  test("a same-origin redirect keeps the credentials; a redirect loop is cut off", async () => {
    let calls = serveOpenapi({ "https://api.example.com/openapi.json": redirectTo("/v2/openapi.json"), "https://api.example.com/v2/openapi.json": GITHUB_SLICE });
    await connectAll([defineOpenapiConnection({ name: "ex", url: "https://api.example.com/openapi.json", baseUrl: "https://api.example.com", auth: secretAuth })]);
    expect(calls[1]!.url).toBe("https://api.example.com/v2/openapi.json");
    expect(calls[1]!.headers.authorization).toBe("Bearer ghs_SECRET");

    calls = serveOpenapi({ "https://api.example.com/openapi.json": redirectTo("/openapi.json") });
    const { report } = await connectAll([defineOpenapiConnection({ name: "loop", url: "https://api.example.com/openapi.json", docAuth: true, auth: secretAuth })]);
    expect(report[0]!.error).toContain("more than 5 redirects");
    expect(calls).toHaveLength(6);
  });

  test("a 401 after a cross-origin redirect says credentials weren't forwarded (docAuth wouldn't help)", async () => {
    const CDN = "https://cdn.example.net/private.json";
    serveOpenapi({ "https://api.example.com/openapi.json": redirectTo(CDN), [CDN]: () => new Response("no", { status: 401 }) });
    const { report } = await connectAll([
      defineOpenapiConnection({ name: "ex", url: "https://api.example.com/openapi.json", baseUrl: "https://api.example.com", auth: secretAuth }),
    ]);
    expect(report[0]!.error).toContain("redirected to https://cdn.example.net");
    expect(report[0]!.error).not.toContain("docAuth");
  });

  test("a protected document fetched without credentials fails with a hint naming baseUrl / docAuth", async () => {
    serveOpenapi({ "https://api.example.com/openapi.json": () => new Response("no", { status: 401 }) });
    const { report } = await connectAll([defineOpenapiConnection({ name: "p", url: "https://api.example.com/openapi.json", auth: secretAuth })]);
    expect(report[0]!.error).toContain("401");
    expect(report[0]!.error).toMatch(/baseUrl.*docAuth: true/);
  });
});

describe("OpenAPI: GitHub's real description", () => {
  test("$ref parameters resolve: named properties, path params required, placeholders substituted", async () => {
    const calls = serveOpenapi({ [RAW]: GITHUB_SLICE }, () => Response.json([{ number: 1 }]));
    const { actions } = await connectAll([defineOpenapiConnection({ name: "gh", url: RAW })]);
    const list = actions.find((a) => a.id === "gh__issues_list-for-repo")!;
    expect(Object.keys(list.input.properties)).toContain("owner");
    expect(Object.keys(list.input.properties)).toContain("per_page");
    expect(Object.keys(list.input.properties)).not.toContain("undefined");
    expect(list.input.required).toEqual(["owner", "repo"]);
    expect((list.input.properties as Record<string, { type?: string }>).per_page!.type).toBe("integer");

    expect(await list.run({ owner: "acme", repo: "widgets", per_page: 5, state: "open" } as never, {} as never)).toEqual([{ number: 1 }]);
    const call = calls.at(-1)!;
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/issues?state=open&per_page=5");
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
  });

  test("operationIds with slashes become valid tool names (^[a-zA-Z0-9_-]{1,128}$)", async () => {
    serveOpenapi({ [RAW]: GITHUB_SLICE });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "gh", url: RAW })]);
    expect(actions.map((a) => a.id).sort()).toEqual(["gh__issues_create", "gh__issues_list-for-repo"]);
    for (const a of actions) expect(a.id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  test("the JSON body's fields reach the model and the request; path params stay out of the body", async () => {
    const calls = serveOpenapi({ [RAW]: GITHUB_SLICE }, () => Response.json({ number: 7 }, { status: 201 }));
    const { actions } = await connectAll([defineOpenapiConnection({ name: "gh", url: RAW })]);
    const create = actions.find((a) => a.id === "gh__issues_create")!;
    expect(create.input.required).toEqual(["owner", "repo", "title"]);
    expect(await create.run({ owner: "acme", repo: "widgets", title: "Bug", labels: ["x"] } as never, {} as never)).toEqual({ number: 7 });
    expect(calls.at(-1)!.body).toEqual({ title: "Bug", labels: ["x"] });
  });

  test("include narrows by operationId, by tag, or by predicate", async () => {
    serveOpenapi({ [RAW]: GITHUB_SLICE });
    const ids = async (include: NonNullable<Parameters<typeof defineOpenapiConnection>[0]["include"]>) =>
      (await connectAll([defineOpenapiConnection({ name: "gh", url: RAW, include })])).actions.map((a) => a.id).sort();
    expect(await ids(["issues/create"])).toEqual(["gh__issues_create"]);
    expect(await ids(["issues"])).toEqual(["gh__issues_create", "gh__issues_list-for-repo"]);
    expect(await ids((op) => op.method === "get")).toEqual(["gh__issues_list-for-repo"]);
    expect(await ids(["pulls"])).toEqual([]);
  });
});

describe("OpenAPI: spec features the minimal client used to mishandle", () => {
  const doc = (paths: Record<string, unknown>, components: Record<string, unknown> = {}) => ({ servers: [{ url: "https://api.test" }], paths, components });

  test("path-level parameters apply to every operation; an operation's own (name, in) overrides; non-method keys are skipped", async () => {
    serveOpenapi({
      "https://api.test/doc": doc({
        "/items/{id}": {
          summary: "an item",
          parameters: [{ name: "id", in: "path", schema: { type: "string" }, description: "shared" }],
          get: { operationId: "getItem", parameters: [{ name: "id", in: "path", schema: { type: "integer" }, description: "own" }] },
          delete: { operationId: "deleteItem" },
        },
      }),
    });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    expect(actions.map((a) => a.id).sort()).toEqual(["t__deleteItem", "t__getItem"]);
    const props = (id: string) => actions.find((a) => a.id === id)!.input.properties as Record<string, { type: string; description?: string }>;
    expect(props("t__getItem").id).toEqual({ type: "integer", description: "own" });
    expect(props("t__deleteItem").id).toEqual({ type: "string", description: "shared" });
  });

  test("header params go into headers, cookie params are dropped, unresolvable refs are skipped (never an \"undefined\" property)", async () => {
    const calls = serveOpenapi({
      "https://api.test/doc": doc({
        "/x": {
          get: {
            operationId: "x",
            parameters: [
              { name: "X-Trace", in: "header", schema: { type: "string" } },
              { name: "session", in: "cookie", schema: { type: "string" } },
              { $ref: "#/components/parameters/missing" },
              { $ref: "other.yaml#/components/parameters/remote" },
            ],
          },
        },
      }),
    });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    expect(Object.keys(actions[0]!.input.properties)).toEqual(["X-Trace"]);
    await actions[0]!.run({ "X-Trace": "abc" } as never, {} as never);
    expect(calls.at(-1)!.url).toBe("https://api.test/x");
    expect(calls.at(-1)!.headers["x-trace"]).toBe("abc");
  });

  test("a $ref body schema is inlined — nested refs too — and a recursive schema terminates", async () => {
    serveOpenapi({
      "https://api.test/doc": doc(
        { "/nodes": { post: { operationId: "createNode", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } },
        {
          schemas: {
            Node: { type: "object", required: ["name"], properties: { name: { type: "string" }, meta: { $ref: "#/components/schemas/Meta" }, child: { $ref: "#/components/schemas/Node" } } },
            Meta: { type: "object", properties: { tag: { type: "string" } } },
          },
        },
      ),
    });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    const input = actions[0]!.input;
    expect(input.required).toEqual(["name"]);
    const props = input.properties as Record<string, Record<string, unknown>>;
    expect(props.meta).toEqual({ type: "object", properties: { tag: { type: "string" } } });
    expect(JSON.stringify(input)).not.toContain("$ref"); // nothing dangling for the model API
    // Node → child → Node … : the cycle becomes an open schema instead of
    // recursing forever (or leaving a dangling $ref).
    expect(props.child).toEqual({});
  });

  test("a non-2xx response throws with the status instead of returning the error body as data", async () => {
    serveOpenapi({ "https://api.test/doc": doc({ "/x": { get: { operationId: "x" } } }) }, () => Response.json({ message: "Not Found" }, { status: 404 }));
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    await expect(actions[0]!.run({} as never, {} as never)).rejects.toThrow(/t: GET \/x failed \(404\): \{"message":"Not Found"\}/);
  });

  test("an empty 2xx body is null and a non-JSON one is its text", async () => {
    let reply = () => new Response(null, { status: 204 });
    serveOpenapi({ "https://api.test/doc": doc({ "/x": { get: { operationId: "x" } } }) }, () => reply());
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    expect(await actions[0]!.run({} as never, {} as never)).toBeNull();
    reply = () => new Response("plain text", { status: 200 });
    expect(await actions[0]!.run({} as never, {} as never)).toBe("plain text");
  });

  test("colliding and over-long tool names stay unique and within 128 characters", async () => {
    const long = "op".repeat(100);
    serveOpenapi({
      "https://api.test/doc": doc({
        "/a": { get: { operationId: "list/items" }, post: { operationId: "list.items" } },
        "/b": { get: { operationId: long }, post: { operationId: `${long}x` } },
      }),
    });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain("t__list_items");
    expect(ids).toContain("t__list_items_2");
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  test("an already-valid operationId keeps its id even when a reduced one listed earlier would take it", async () => {
    const calls = serveOpenapi({
      "https://api.test/doc": doc({ "/a": { get: { operationId: "list/items" } }, "/b": { get: { operationId: "list_items" } } }),
    });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "t", url: "https://api.test/doc" })]);
    expect(actions.map((a) => a.id)).toEqual(["t__list_items_2", "t__list_items"]);
    await actions.find((a) => a.id === "t__list_items")!.run({} as never, {} as never);
    expect(calls.at(-1)!.url).toBe("https://api.test/b"); // still the operation that was always list_items
  });

  test("the connection name is sanitized too (a connection named after its host)", async () => {
    serveOpenapi({ "https://api.test/doc": doc({ "/a": { get: { operationId: "list" } } }) });
    const { actions } = await connectAll([defineOpenapiConnection({ name: "api.github.com", url: "https://api.test/doc" })]);
    expect(actions.map((a) => a.id)).toEqual(["api_github_com__list"]);
  });

  test("many operations without include warn once; include silences it", async () => {
    const paths = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`/p${i}`, { get: { operationId: `op${i}` } }]));
    serveOpenapi({ "https://api.test/doc": doc(paths) });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (msg: string) => void warned.push(msg);
    try {
      await connectAll([defineOpenapiConnection({ name: "big", url: "https://api.test/doc" })]);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('connection "big": 101 OpenAPI operations');
      ACTION_REGISTRY.clear();
      await connectAll([defineOpenapiConnection({ name: "big", url: "https://api.test/doc", include: (op) => op.path !== "/p0" })]);
      expect(warned).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });
});

// Every MCP behavior below runs against BOTH protocol eras: June's client probes
// with a modern server/discover and falls back to the 2025-era initialize.
for (const era of ["modern", "legacy"] as const) {
  describe(`MCP (${era} server): tool ids are valid tool names; the remote is still called by its own name`, () => {
    // MCP allows dots ("admin.tools.list") and names up to 128 characters before
    // our `<connection>__` prefix — both break the model API's ^[a-zA-Z0-9_-]{1,128}$.
    const called = (calls: FakeCall[]) => calls.filter((c) => c.method === "tools/call").map((c) => (c.body.params as { name: string }).name);

    test("dotted, over-long and colliding names get valid, unique ids — and each still calls its own remote tool", async () => {
      const long = "t".repeat(128); // valid in MCP; with the "srv__" prefix it is not
      const server = fakeMcpServer({ era, tools: ["admin.tools.list", "admin_tools_list", long, "get_weather"] });
      server.install();
      const { actions, report } = await connectAll([defineMcpConnection({ name: "srv", url: "http://x/mcp" })]);
      const ids = actions.map((a) => a.id);
      // The already-valid "admin_tools_list" keeps its id even though the dotted
      // name that reduces to the same id is listed first: only the reduced one
      // is suffixed, so an existing caller of srv__admin_tools_list still reaches
      // the same remote tool.
      expect(ids).toEqual(["srv__admin_tools_list_2", "srv__admin_tools_list", `srv__${long}`.slice(0, 128), "srv__get_weather"]);
      expect(report[0]!.tools).toEqual(ids);
      for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);

      for (const a of actions) await a.run({}, {} as never);
      expect(called(server.calls)).toEqual(["admin.tools.list", "admin_tools_list", long, "get_weather"]);
    });

    test("a connection named after its host yields valid ids", async () => {
      fakeMcpServer({ era, tools: ["search"] }).install();
      const { actions } = await connectAll([defineMcpConnection({ name: "mcp.example.com", url: "http://x/mcp" })]);
      expect(actions.map((a) => a.id)).toEqual(["mcp_example_com__search"]);
    });
  });

  describe(`MCP (${era} server): tools/list pagination (spec 2026-07-28)`, () => {
    const connect = () => connectAll([defineMcpConnection({ name: "srv", url: "http://x/mcp" })]);
    const cursors = (calls: FakeCall[]) =>
      calls.filter((c) => c.method === "tools/list").map((c) => {
        const p = c.body.params as Record<string, unknown> | undefined;
        return p && "cursor" in p ? (p.cursor as string) : START;
      });

    test("follows nextCursor across pages, sending each cursor back verbatim (opaque)", async () => {
      const server = fakeMcpServer({
        era,
        pages: new Map<string | typeof START, FakePage>([
          [START, { tools: ["a", "b"], nextCursor: "eyJwYWdlIjogMn0=/+" }],
          ["eyJwYWdlIjogMn0=/+", { tools: ["c"], nextCursor: "p3" }],
          ["p3", { tools: ["d"] }],
        ]),
      });
      server.install();
      const { actions, report } = await connect();
      expect(actions.map((a) => a.id)).toEqual(["srv__a", "srv__b", "srv__c", "srv__d"]);
      expect(report[0]!.error).toBeUndefined();
      expect(cursors(server.calls)).toEqual([START, "eyJwYWdlIjogMn0=/+", "p3"]); // the first request carries no cursor
    });

    test('an EMPTY-STRING nextCursor is a cursor, not the end: "" is sent back and the next page is read', async () => {
      const server = fakeMcpServer({
        era,
        pages: new Map<string | typeof START, FakePage>([
          [START, { tools: ["a"], nextCursor: "" }],
          ["", { tools: ["b"] }],
        ]),
      });
      server.install();
      const { actions } = await connect();
      expect(actions.map((a) => a.id)).toEqual(["srv__a", "srv__b"]);
      expect(cursors(server.calls)).toEqual([START, ""]);
    });

    test("a null nextCursor ends the listing, like an absent one", async () => {
      const server = fakeMcpServer({ era, pages: new Map<string | typeof START, FakePage>([[START, { tools: ["a"], nextCursor: null }]]) });
      server.install();
      const { actions } = await connect();
      expect(actions.map((a) => a.id)).toEqual(["srv__a"]);
      expect(cursors(server.calls)).toEqual([START]);
    });

    test("a server that repeats a cursor fails the connection (never hangs) and registers nothing", async () => {
      fakeMcpServer({
        era,
        pages: new Map<string | typeof START, FakePage>([
          [START, { tools: ["a"], nextCursor: "x" }],
          ["x", { tools: ["b"], nextCursor: "x" }],
        ]),
      }).install();
      const { actions, report } = await connect();
      expect(actions).toEqual([]);
      expect(report[0]!.error).toContain('repeated cursor "x"');
      expect([...ACTION_REGISTRY.keys()].filter((id) => id.startsWith("srv__"))).toEqual([]);
    });

    test("an endless listing is cut off after 100 pages with an error, not silently truncated", async () => {
      const pages = new Map<string | typeof START, FakePage>([[START, { tools: ["t0"], nextCursor: "c1" }]]);
      for (let i = 1; i <= 200; i++) pages.set(`c${i}`, { tools: [`t${i}`], nextCursor: `c${i + 1}` });
      const server = fakeMcpServer({ era, pages });
      server.install();
      const { actions, report } = await connect();
      expect(actions).toEqual([]);
      expect(report[0]!.error).toContain("more than 100 pages");
      expect(cursors(server.calls)).toHaveLength(100);
    });

    test("a page without the required `tools` array fails the connection, not read as an empty page", async () => {
      const server = fakeMcpServer({ era, pages: new Map<string | typeof START, FakePage>([[START, { tools: ["a"], nextCursor: "p2" }]]) });
      server.install();
      // Page 2 answers a result with no `tools` at all (malformed).
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const rpc = JSON.parse(String(init!.body)) as { id: unknown; method: string; params?: { cursor?: string } };
        if (rpc.method === "tools/list" && rpc.params?.cursor === "p2") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {} });
        return server.fetch(url as string, init);
      }) as typeof fetch;
      const { actions, report } = await connect();
      expect(actions).toEqual([]);
      expect(report[0]!.error).toContain("page 2 has no `tools` array");
    });

    test("an invalid-cursor error from the server fails the connection with the server's message", async () => {
      fakeMcpServer({ era, pages: new Map<string | typeof START, FakePage>([[START, { tools: ["a"], nextCursor: "gone" }]]) }).install();
      const { report } = await connect();
      expect(report[0]!.error).toContain("invalid cursor gone");
    });
  });
}

test("MCP: already-valid tool names are unchanged", async () => {
  mockRemotes();
  const { actions } = await connectAll([defineMcpConnection({ name: "weather", url: "http://x/mcp" })]);
  expect(actions.map((a) => a.id)).toEqual(["weather__get_weather"]);
});
