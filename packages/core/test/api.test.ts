import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ACTION_REGISTRY, defineAction, type AnyAction } from "@junejs/core/agent";
import { apiActionId, apiActionPath, apiHandler, isJsonContentType, isRoutableActionId, openApiDocument } from "@junejs/core/api";

const ORIGIN = "https://example.com";

// A bare server action: registered, but with no description (no schema to describe).
const action = (_fn: unknown, id: string) =>
  ACTION_REGISTRY.set(id, { id, description: "", input: { type: "object", properties: {} }, run: () => 1 } as AnyAction);

// Same registry hygiene as discovery.test.ts: empty per test, restored after.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  ACTION_REGISTRY.clear();
  for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
});

function post(id: string, body?: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request(`${ORIGIN}/api/${id}`, { method: "POST", headers, body });
}

type ErrorBody = { error: { code: string; message: string; hint?: string } };

function defineFixtures() {
  defineAction({
    id: "add",
    description: "Add two numbers. Returns their sum.",
    input: {
      type: "object",
      properties: { a: { type: "number", description: "First" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    annotations: { readOnlyHint: true },
    run: (i) => ({ sum: i.a + i.b }),
  });
  defineAction({
    id: "whoami",
    description: "The caller's tenant.",
    input: { type: "object", properties: {} },
    requiresPrincipal: true,
    run: (_i, ctx) => ({ tenant: ctx.user?.id }),
  });
  defineAction({
    id: "boom",
    description: "Always fails.",
    input: { type: "object", properties: {} },
    run: () => {
      throw new Error("kaput");
    },
  });
}

describe("apiActionId()", () => {
  test("claims only /api/<registered rich action id>", () => {
    defineFixtures();
    expect(apiActionId("/api/add")).toBe("add");
    expect(apiActionId("/api/nope")).toBeNull(); // the app's own /api route
    expect(apiActionId("/api/")).toBeNull();
    expect(apiActionId("/add")).toBeNull();
    expect(apiActionId("/api/%E0%A4%A")).toBeNull(); // malformed escape
  });

  test("a bare server action (no description) is not on this surface", () => {
    action(async () => 1, "bare_action");
    expect(apiActionId("/api/bare_action")).toBeNull();
  });
});

describe("action ids as path segments", () => {
  const reversible = ["...", "a/b", "%", "%2e", "排版", "a b", "q?x#y", "posts.create"];

  test("every id except '', '.', '..' round-trips: path → URL parse → apiActionId", () => {
    for (const id of [...reversible, "", ".", ".."]) {
      ACTION_REGISTRY.set(id, { id, description: `Tool ${id}`, input: { type: "object", properties: {} }, run: () => id } as AnyAction);
    }
    for (const id of reversible) {
      expect(isRoutableActionId(id)).toBe(true);
      // exactly what the pipeline sees: a request to the documented path, parsed by URL
      const { pathname } = new URL(`${ORIGIN}${apiActionPath(id)}`);
      expect(apiActionId(pathname)).toBe(id);
    }
    for (const id of ["", ".", ".."]) expect(isRoutableActionId(id)).toBe(false);
  });

  test("an unroutable id is left out of /openapi.json (warned once) but stays registered", () => {
    for (const id of ["...", ".", ".."]) {
      ACTION_REGISTRY.set(id, { id, description: `Tool ${id}`, input: { type: "object", properties: {} }, run: () => id } as AnyAction);
    }
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // Count only this surface's warnings: spyOn hands back an existing console.warn
    // mock (with its history) if another file left one installed.
    warn.mockClear();
    const unroutableWarnings = () =>
      warn.mock.calls.map(([msg]) => String(msg)).filter((m) => m.includes("can't be a URL path segment"));
    try {
      const paths = Object.keys((openApiDocument(ORIGIN) as { paths: object }).paths);
      openApiDocument(ORIGIN); // a second render doesn't warn again
      expect(paths).toEqual(["/api/..."]);
      // one warning per unroutable id ("." and ".."), not one per render
      const msgs = unroutableWarnings();
      expect(msgs).toHaveLength(2);
      expect(msgs.some((m) => m.includes(`id "."`))).toBe(true);
      expect(msgs.some((m) => m.includes(`id ".."`))).toBe(true);
      for (const m of msgs) expect(m).toContain("still works over /mcp");
    } finally {
      warn.mockRestore();
    }
    expect(ACTION_REGISTRY.has(".")).toBe(true); // registration is untouched (MCP/RSC keep it)
  });

  test("only the canonical path matches: no literal nested path, no alternate spelling", () => {
    for (const id of ["a/b", "add"]) {
      ACTION_REGISTRY.set(id, { id, description: `Tool ${id}`, input: { type: "object", properties: {} }, run: () => id } as AnyAction);
    }
    expect(apiActionId("/api/a%2Fb")).toBe("a/b"); // the advertised path
    expect(apiActionId("/api/a/b")).toBeNull(); // an app's nested route, not action "a/b"
    expect(apiActionId("/api/a%2fb")).toBeNull(); // lower-case escape: not canonical
    expect(apiActionId("/api/%61dd")).toBeNull(); // "%61" spells "a" but isn't canonical
    expect(apiActionId("/api/add")).toBe("add");
  });

  test("an unencodable id (lone surrogate) is unroutable, not a crash of /openapi.json", () => {
    const lone = "bad\uD800";
    ACTION_REGISTRY.set(lone, { id: lone, description: "Lone surrogate", input: { type: "object", properties: {} }, run: () => 1 } as AnyAction);
    defineFixtures();
    expect(isRoutableActionId(lone)).toBe(false);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    try {
      const paths = Object.keys((openApiDocument(ORIGIN) as { paths: object }).paths);
      expect(paths.sort()).toEqual(["/api/add", "/api/boom", "/api/whoami"]);
      const msgs = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("can't be a URL path segment"));
      expect(msgs).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    // a request whose decoded suffix is invalid UTF-8 is simply not ours
    expect(apiActionId("/api/%ED%A0%80")).toBeNull();
  });

  test("apiHandler refuses an unroutable id even when called directly", async () => {
    ACTION_REGISTRY.set(".", { id: ".", description: "Dot", input: { type: "object", properties: {} }, run: () => 1 } as AnyAction);
    const res = await apiHandler(new Request(`${ORIGIN}/api/x`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), ".");
    expect(res.status).toBe(404);
  });
});

describe("apiHandler()", () => {
  test("POST runs the action and returns its result as JSON", async () => {
    defineFixtures();
    const res = await apiHandler(post("add", JSON.stringify({ a: 2, b: 3 })), "add");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ sum: 5 });
  });

  test("an empty JSON body is {}", async () => {
    defineFixtures();
    const res = await apiHandler(post("whoami", ""), "whoami", { user: { id: "acme" } });
    expect(await res.json()).toEqual({ tenant: "acme" });
  });

  test("non-POST → 405 with Allow", async () => {
    defineFixtures();
    const res = await apiHandler(new Request(`${ORIGIN}/api/add`), "add");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(((await res.json()) as ErrorBody).error.code).toBe("method_not_allowed");
  });

  test("GET/HEAD on an id this surface doesn't serve → 404 not_found, not 405", async () => {
    defineFixtures();
    ACTION_REGISTRY.set("bare_get", { id: "bare_get", description: "", input: { type: "object", properties: {} }, run: () => 1 } as AnyAction);
    ACTION_REGISTRY.set(".", { id: ".", description: "Dot", input: { type: "object", properties: {} }, run: () => 1 } as AnyAction);
    for (const id of ["never_registered", "bare_get", "."]) {
      const get = await apiHandler(new Request(`${ORIGIN}/api/x`), id);
      expect(get.status, id).toBe(404);
      expect(get.headers.get("allow"), id).toBeNull();
      expect(((await get.json()) as ErrorBody).error.code, id).toBe("not_found");
      const head = await apiHandler(new Request(`${ORIGIN}/api/x`, { method: "HEAD" }), id);
      expect(head.status, id).toBe(404);
      expect(head.body, id).toBeNull();
    }
    // a served action still answers GET with 405
    expect((await apiHandler(new Request(`${ORIGIN}/api/add`), "add")).status).toBe(405);
  });

  test("HEAD → the same 405 status + headers as GET, with no body", async () => {
    defineFixtures();
    const get = await apiHandler(new Request(`${ORIGIN}/api/add`), "add");
    const head = await apiHandler(new Request(`${ORIGIN}/api/add`, { method: "HEAD" }), "add");
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("POST");
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.body).toBeNull();
  });

  test("a non-JSON content type → 415 (no simple cross-site POST reaches an action)", async () => {
    defineFixtures();
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      const res = await apiHandler(post("add", `{"a":1,"b":2}`, ct ? { "content-type": ct } : {}), "add");
      expect(res.status).toBe(415);
      expect(((await res.json()) as ErrorBody).error.code).toBe("unsupported_media_type");
    }
    // +json suffixes are JSON
    const ok = await apiHandler(post("add", `{"a":1,"b":2}`, { "content-type": "application/vnd.x+json" }), "add");
    expect(ok.status).toBe(200);
  });

  test("isJsonContentType: the essence must be exactly JSON, then only ; parameters", () => {
    for (const ct of [
      "application/json",
      "APPLICATION/JSON",
      "application/json; charset=utf-8",
      "  application/json  ;  charset=UTF-8 ",
      "application/json;charset=utf-8;foo=bar",
      "application/vnd.api+json",
      "application/merge-patch+json",
      "application/problem+json; charset=utf-8",
      'application/json; charset="utf-8"', // quoted-string value
      'application/json; x="a \\"q\\" ;b"', // quoted-pair + ; inside quotes
      "application/json;", // empty parameter: grammatical (RFC 9110 §5.6.6)
      "application/json;;;", // ditto
      "application/json; ; charset=utf-8",
      "application/json\t;\tcharset=utf-8", // OWS includes HTAB
    ]) {
      expect(isJsonContentType(ct), ct).toBe(true);
    }
    for (const ct of [
      null,
      "",
      "application/json-patch", // a different subtype sharing a prefix
      "application/json garbage", // junk after the essence, not a parameter
      "application/json; garbage", // a parameter must be token=value
      "application/json; charset", // name without =value
      "application/json; charset=", // empty value
      "application/json; charset = utf-8", // no whitespace around "="
      'application/json; charset="utf-8', // unterminated quoted-string
      "application/json; a=b c", // junk after a value
      "application/json,text/plain", // not a list
      "application /json", // no whitespace inside the essence
      "application/jsonx",
      "application/json-seq",
      "application/json+xml",
      "text/plain",
      "text/plain; a=application/json", // JSON only inside a parameter
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "+json",
      "application/+json",
      "json",
    ]) {
      expect(isJsonContentType(ct), String(ct)).toBe(false);
    }
  });

  test("malformed JSON → 400 invalid_json", async () => {
    defineFixtures();
    const res = await apiHandler(post("add", "{nope"), "add");
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe("invalid_json");
  });

  test("schema violations → 400 invalid_input with a hint at the schema", async () => {
    defineFixtures();
    for (const body of [`{"a":1}`, `{"a":"1","b":2}`, `[1,2]`]) {
      const res = await apiHandler(post("add", body), "add");
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as ErrorBody;
      expect(error.code).toBe("invalid_input");
      expect(error.hint).toContain("/openapi.json");
    }
  });

  test("requiresPrincipal without a principal → 401 unauthorized; with one → runs", async () => {
    defineFixtures();
    const anon = await apiHandler(post("whoami", "{}"), "whoami");
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as ErrorBody).error.code).toBe("unauthorized");
    const authed = await apiHandler(post("whoami", "{}"), "whoami", { user: { id: "t1" } });
    expect(await authed.json()).toEqual({ tenant: "t1" });
  });

  test("a throwing action → 500 execution_error with the message, never a stack", async () => {
    defineFixtures();
    const res = await apiHandler(post("boom", "{}"), "boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "execution_error", message: "kaput" } });
    expect(text).not.toContain("at ");
  });

  test("a bare server action is not_found even when apiHandler is called directly", async () => {
    let ran = false;
    ACTION_REGISTRY.set("bare_direct", {
      id: "bare_direct",
      description: "",
      input: { type: "object", properties: {} },
      run: () => {
        ran = true;
      },
    } as AnyAction);
    const res = await apiHandler(post("bare_direct", "{}"), "bare_direct");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
    expect(ran).toBe(false);
  });

  test("one classification with /mcp: only invokeAction's own refusals get a dispatch code", async () => {
    const { invokeAction } = await import("@junejs/core/agent");
    defineAction({
      id: "nested",
      description: "Lets a nested refusal escape.",
      input: { type: "object", properties: {} },
      run: () => invokeAction("does_not_exist", {}),
    });
    defineAction({
      id: "spoof",
      description: "Throws an error that merely carries a dispatch-like code.",
      input: { type: "object", properties: {} },
      run: () => {
        throw Object.assign(new Error("upstream said no"), { code: "invalid_input" });
      },
    });
    // a nested unknown_action that escapes run() is THIS action's execution failure
    const nested = await apiHandler(post("nested", "{}"), "nested");
    expect(nested.status).toBe(500);
    expect(((await nested.json()) as ErrorBody).error.code).toBe("execution_error");
    // a `code` on an error run() threw is not trusted as a dispatch refusal
    const spoof = await apiHandler(post("spoof", "{}"), "spoof");
    expect(spoof.status).toBe(500);
    expect(((await spoof.json()) as ErrorBody).error).toEqual({ code: "execution_error", message: "upstream said no" });
  });

  test("an action unregistered between routing and dispatch → 404 not_found", async () => {
    const res = await apiHandler(post("gone", "{}"), "gone");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });
});

describe("openApiDocument()", () => {
  test("one POST operation per rich action, function-calling ready", () => {
    defineFixtures();
    action(async () => 1, "bare_action");
    const doc = openApiDocument(ORIGIN, { name: "Acme", description: "Acme's app" }) as {
      openapi: string;
      info: { title: string; description?: string; version: string };
      servers: { url: string }[];
      paths: Record<string, { post: Record<string, unknown> }>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Acme", description: "Acme's app", version: "0.0.0" });
    expect(doc.servers).toEqual([{ url: ORIGIN }]);
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/add", "/api/boom", "/api/whoami"]);

    const ids = Object.values(doc.paths).map((p) => p.post.operationId);
    expect(new Set(ids).size).toBe(ids.length); // unique operationIds
    for (const { post: op } of Object.values(doc.paths)) {
      // every op: an id, a summary, a description, a typed body, a typed 200 and error responses
      expect(typeof op.operationId).toBe("string");
      expect(op.summary).toBeTruthy();
      expect(op.description).toBeTruthy();
      const body = op.requestBody as { content: Record<string, { schema: { type: string } }> };
      expect(body.content["application/json"]!.schema.type).toBe("object");
      const responses = op.responses as Record<string, { content: Record<string, { schema: unknown }> }>;
      expect(responses["200"]!.content["application/json"]!.schema).toBeDefined();
      expect(responses["400"]!.content["application/json"]!.schema).toEqual({ $ref: "#/components/schemas/Error" });
    }

    const add = doc.paths["/api/add"]!.post;
    expect(add.summary).toBe("Add two numbers.");
    expect((add.requestBody as { required: boolean }).required).toBe(true);
    expect(add["x-mcp-annotations"]).toEqual({ readOnlyHint: true });
    const whoami = doc.paths["/api/whoami"]!.post;
    // required even with no required field: clients send `{}` (and so a JSON Content-Type)
    expect((whoami.requestBody as { required: boolean }).required).toBe(true);
    expect(whoami.responses).toHaveProperty("401");
    expect(add.responses).not.toHaveProperty("401");

    // every $ref resolves
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of refs) expect(doc.components.schemas).toHaveProperty(r.split("/").pop()!);
  });

  test("an empty registry is a valid document with no paths", () => {
    const doc = openApiDocument(ORIGIN) as { paths: object; info: { title: string } };
    expect(doc.paths).toEqual({});
    expect(doc.info.title).toBe("June app");
  });
});
