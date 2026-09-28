// connections.ts — CONNECTIONS: an agent's OUTBOUND edge (the mirror of channels).
//
// Where a channel brings the world IN (messages), a connection reaches the world
// OUT (tools): it wires the agent into an external server it does NOT author — an
// MCP server, or any HTTP API with an OpenAPI document — and turns each remote
// operation into a callable tool named `<connection>__<tool>`.
//
// June twist: those remote tools are registered as `defineAction`s, so they join
// the SAME unified registry as local tools. June both CONSUMES external
// MCP/OpenAPI (client, like eve) AND re-serves everything from its own /mcp
// (server) — a transparent MCP gateway. A headless framework only does the client
// half. Credentials never reach the model: `auth` is resolved per call,
// server-side; only the tool's result flows into the transcript.
//
// Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero node:*), so an
// agent can hold connections on native and on edge alike.

import { ACTION_REGISTRY, defineAction, type AnyAction, type JsonSchema, type ToolAnnotations } from "./agent";
import type { ActionContext } from "./context";

// Resolved per call, server-side — the token never reaches the model. The ctx
// is the CALL's identity (ActionContext: `user` is the turn's resolved
// principal via actionToTool, or the request's principal on UI//mcp dispatch),
// so an auth can mint a per-tenant, short-lived credential instead of holding
// one static key. Called WITHOUT ctx at discovery time (initialize/tools/list/
// OpenAPI doc fetch happen before any turn) — an identity-dependent auth must
// handle `ctx === undefined` by returning a discovery-scoped credential.
type Auth = (ctx?: ActionContext) => Promise<{ token: string }> | { token: string };
type Headers = Record<string, string>;

// `requiresPrincipal` gates EVERY tool the connection exposes: on turns without
// a resolved identity they are hidden from the model entirely (the same
// Tool.requiresPrincipal mechanism app tools use). Set it whenever the remote
// serves tenant/user-scoped data — which is almost always true when `auth`
// mints per-tenant tokens.
export type McpConnection = { kind: "mcp"; name: string; url: string; headers?: Headers; auth?: Auth; requiresPrincipal?: boolean };
export type OpenapiConnection = {
  kind: "openapi";
  name: string;
  url: string; // URL of the OpenAPI document
  baseUrl?: string; // overrides servers[0].url
  headers?: Headers;
  auth?: Auth;
  requiresPrincipal?: boolean;
  // Whether the DOCUMENT fetch carries `headers` + `auth`. They are the API's
  // credentials, and documents often live elsewhere (a CDN, raw.githubusercontent.com),
  // so by default they are sent only when `baseUrl` is set and shares the
  // document's origin. `true` always sends them, `false` never does.
  docAuth?: boolean;
  // Which operations become tools. Large APIs describe hundreds (GitHub: 1224),
  // far more than a model can choose between. Strings match an operationId or
  // a tag; a function sees each operation. Unset registers every operation.
  include?: string[] | ((op: OpenapiOperation) => boolean);
};
export type OpenapiOperation = { operationId?: string; method: string; path: string; tags: string[] };
// A PROVIDER connection is the escape hatch for a remote whose transport the
// generic mcp/openapi clients can't express (multipart uploads, alt=media
// downloads, compound path→id operations — Google Drive is the first). It brings
// its OWN client: `connect()` returns the provider's tools as defineActions
// (usually `<name>__<tool>`-prefixed, and resolving their credential per call,
// server-side — the same identity discipline mcp/openapi auth follows). It still
// joins the connection lifecycle: connectAll reports it and isolates its failures.
//
// Identity gate: because the FRAMEWORK does not build a provider's actions (the
// provider does, via defineAction), the gate must be applied WHERE the action is
// registered — otherwise the Flight/server-reference wrapper is snapshotted
// ungated (see agent.ts). So `requiresPrincipal` is passed INTO `connect` as an
// option; the provider must thread it into its defineActions. connectAll then
// fail-fast VERIFIES every returned tool is gated — it never retro-mutates
// (which would leave the Flight path open).
export type ProviderConnectOptions = {
  // When true, the provider MUST build every tool with `requiresPrincipal` so it
  // is gated at registration time (agent turns, /mcp, UI POST, AND the Flight
  // server reference). connectAll enforces this.
  requiresPrincipal?: boolean;
};
export type ProviderConnection = {
  kind: "provider";
  name: string;
  // Build the provider's tools. Static by nature (no per-call ctx — each tool's
  // own run(input, ctx) carries identity); `opts.requiresPrincipal` must be
  // threaded into the tools' defineAction calls.
  connect: (opts: ProviderConnectOptions) => AnyAction[] | Promise<AnyAction[]>;
  // Human-readable label for the ConnectionReport (e.g. the provider's API base).
  url?: string;
  requiresPrincipal?: boolean;
};
export type Connection = McpConnection | OpenapiConnection | ProviderConnection;

export function defineMcpConnection(c: Omit<McpConnection, "kind">): McpConnection {
  return { kind: "mcp", ...c };
}
export function defineOpenapiConnection(c: Omit<OpenapiConnection, "kind">): OpenapiConnection {
  return { kind: "openapi", ...c };
}
export function defineProviderConnection(c: Omit<ProviderConnection, "kind">): ProviderConnection {
  return { kind: "provider", ...c };
}

export type ConnectionReport = { name: string; kind: string; url: string; tools: string[]; error?: string };

async function resolveHeaders(c: McpConnection | OpenapiConnection, ctx?: ActionContext): Promise<Headers> {
  const h: Headers = { "content-type": "application/json", ...(c.headers ?? {}) };
  if (c.auth) {
    const { token } = await c.auth(ctx);
    h["authorization"] = `Bearer ${token}`;
  }
  return h;
}

// --- tool ids -----------------------------------------------------------------

// The Claude API's tool-name rule (other providers are no looser).
const TOOL_NAME_MAX = 128;

// `<connection>__<remote name>`, reduced to the tool-name alphabet
// (^[a-zA-Z0-9_-]{1,128}$) as a WHOLE. Remote names routinely fall outside it:
// GitHub's operationIds are "issues/list-for-repo", MCP explicitly allows dots
// ("admin.tools.list") and names up to 128 characters BEFORE our prefix, and a
// connection may be named "github.com". One invalid id makes the model API
// reject every request of the agent. The remote is still called by its own
// name — only the id the model and /mcp see is reduced.
//
// Ids are assigned for the whole list at once, in two passes, so that an id
// which was ALREADY valid never moves: pass 1 reserves every valid
// `<connection>__<name>` as-is; pass 2 reduces the rest and suffixes only them
// on a collision. Otherwise a reduced "admin.tools.list" listed first would take
// `srv__admin_tools_list` from the real "admin_tools_list", and an existing
// caller of that id would silently invoke a different remote tool.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

function toolIds(connection: string, remoteNames: readonly string[]): string[] {
  const ids: (string | undefined)[] = [];
  const taken = new Set<string>();
  remoteNames.forEach((name, i) => {
    const raw = `${connection}__${name}`;
    if (TOOL_NAME.test(raw) && !taken.has(raw)) {
      ids[i] = raw;
      taken.add(raw);
    }
  });
  return remoteNames.map((name, i) => {
    const kept = ids[i];
    if (kept !== undefined) return kept;
    const base = `${connection}__${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, TOOL_NAME_MAX);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base.slice(0, TOOL_NAME_MAX - String(n).length - 1)}_${n}`;
    taken.add(id);
    return id;
  });
}

// --- MCP client ---------------------------------------------------------------

async function rpc(url: string, headers: Headers, method: string, params?: object) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

type McpTool = { name: string; description?: string; inputSchema?: JsonSchema; annotations?: ToolAnnotations };

// A server bug that never ends the listing must fail the connection, not hang it.
const MAX_TOOL_PAGES = 100;

// tools/list is paginated: follow `nextCursor` until the server omits it. The
// cursor is opaque — per the spec (2026-07-28), only a missing/null nextCursor
// ends the listing; an EMPTY STRING is a valid cursor and must be sent back.
// Stopping at page 1 would silently drop every later tool; a repeated cursor
// or an endless listing throws instead, so tools are never lost without a
// report.
async function listMcpTools(c: McpConnection): Promise<McpTool[]> {
  const headers = await resolveHeaders(c); // one discovery credential for the whole listing
  const tools: McpTool[] = [];
  const sent = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    const result = (await rpc(c.url, headers, "tools/list", cursor === undefined ? undefined : { cursor })) as {
      tools?: McpTool[];
      nextCursor?: string | null;
    };
    tools.push(...(result.tools ?? []));
    const next = result.nextCursor;
    if (next === undefined || next === null) return tools;
    if (sent.has(next)) throw new Error(`tools/list: the server repeated cursor ${JSON.stringify(next)} — the listing would never end.`);
    if (page >= MAX_TOOL_PAGES) throw new Error(`tools/list: more than ${MAX_TOOL_PAGES} pages — refusing to keep listing.`);
    sent.add(next);
    cursor = next;
  }
}

async function connectMcp(c: McpConnection): Promise<AnyAction[]> {
  await rpc(c.url, await resolveHeaders(c), "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "june", version: "0.0.0" },
  });
  const tools = await listMcpTools(c);

  const ids = toolIds(c.name, tools.map((t) => t.name));
  return tools.map((t, i) =>
    defineAction({
      id: ids[i]!,
      description: `[${c.name}] ${t.description ?? t.name}`,
      input: t.inputSchema ?? { type: "object", properties: {} },
      // Gateway fidelity: the remote's behavior hints survive re-serving.
      ...(t.annotations ? { annotations: t.annotations } : {}),
      ...(c.requiresPrincipal ? { requiresPrincipal: true } : {}),
      // async ⇒ the engine treats this as a remote (at-least-once) tool.
      // ctx flows from the dispatch path (turn ToolContext → ActionContext via
      // actionToTool, or the request identity on UI//mcp) into auth — a
      // per-tenant auth mints the CALLER's credential, never a global one.
      run: async (input: unknown, ctx: ActionContext) => {
        const result = (await rpc(c.url, await resolveHeaders(c, ctx), "tools/call", { name: t.name, arguments: input })) as {
          content?: { type: string; text?: string }[];
        };
        const text = result.content?.find((b) => b.type === "text")?.text;
        if (text === undefined) return result;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    }),
  );
}

// --- OpenAPI client (minimal, honest subset) ----------------------------------

type Json = Record<string, unknown>;
type OpenApiDoc = { servers?: { url: string }[]; paths?: Record<string, Json>; components?: Json };
type Parameter = { name?: string; in?: string; required?: boolean; schema?: Json; description?: string };
type Operation = {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { content?: { "application/json"?: { schema?: Json } } };
};

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
// A connection this large without `include` is almost certainly unintended:
// every tool's schema is sent to the model on every turn.
const MANY_OPERATIONS = 100;
// How many $ref hops a schema is inlined through before the rest is left open
// ({}): enough for a request body's nested objects, bounded against both cycles
// and the size blow-up of deeply linked vendor schemas.
const MAX_REF_DEPTH = 3;
// Resolve a LOCAL JSON pointer ("#/components/parameters/owner"); remote refs
// ("other.yaml#/…") are not fetched and resolve to undefined.
function resolvePointer(doc: OpenApiDoc, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object") return undefined;
    node = (node as Json)[key];
  }
  return node;
}

// Inline every $ref in a node (a parameter, a schema), guarding cycles and depth.
// An unresolvable or too-deep ref becomes {} — an open schema — never a dangling
// "$ref" a model API would reject.
function inline(doc: OpenApiDoc, node: unknown, seen: readonly string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => inline(doc, n, seen));
  if (!node || typeof node !== "object") return node;
  const ref = (node as Json).$ref;
  if (typeof ref === "string") {
    if (seen.includes(ref) || seen.length >= MAX_REF_DEPTH) return {};
    const target = resolvePointer(doc, ref);
    return target === undefined ? {} : inline(doc, target, [...seen, ref]);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) out[k] = inline(doc, v, seen);
  return out;
}

function property(p: Parameter): { type: string; description?: string } {
  const schema = p.schema ?? {};
  const composite = "oneOf" in schema || "anyOf" in schema || "allOf" in schema || "enum" in schema;
  return {
    ...schema,
    ...(schema.type || composite ? {} : { type: "string" }),
    ...(p.description ? { description: p.description } : {}),
  } as { type: string; description?: string };
}

function includes(c: OpenapiConnection, op: OpenapiOperation): boolean {
  if (!c.include) return true;
  if (typeof c.include === "function") return c.include(op);
  return c.include.some((s) => s === op.operationId || op.tags.includes(s));
}

const MAX_DOC_REDIRECTS = 5;

async function fetchOpenapiDoc(c: OpenapiConnection): Promise<OpenApiDoc> {
  const docOrigin = new URL(c.url).origin;
  const sameOrigin = c.baseUrl !== undefined && new URL(c.baseUrl, c.url).origin === docOrigin;
  const allowed = c.docAuth ?? sameOrigin;
  // Discovery credentials (auth with no ctx) only when they are going to the API itself.
  const credentials = allowed ? await resolveHeaders(c) : undefined;
  // Credentials are for the document's ORIGIN, not wherever it redirects: fetch
  // forwards custom headers (x-api-key, …) across origins on redirect, so a
  // credentialed fetch follows redirects by hand and drops them on any hop that
  // leaves that origin.
  let url = c.url;
  let res: Response;
  let sent = false;
  for (let hop = 0; ; hop++) {
    sent = credentials !== undefined && new URL(url).origin === docOrigin;
    res = await fetch(url, credentials ? { redirect: "manual", ...(sent ? { headers: credentials } : {}) } : {});
    const location = res.headers.get("location");
    if (!credentials || res.status < 300 || res.status >= 400 || !location) break;
    if (hop >= MAX_DOC_REDIRECTS) throw new Error(`OpenAPI document ${c.url}: more than ${MAX_DOC_REDIRECTS} redirects.`);
    url = new URL(location, url).href;
  }
  if (!res.ok) {
    const denied = (res.status === 401 || res.status === 403) && !sent && (c.auth || c.headers);
    const hint = !denied
      ? ""
      : credentials
        ? ` It redirected to ${new URL(url).origin}, and credentials are never forwarded to another origin: point \`url\` at the final location.`
        : " The document was fetched WITHOUT the connection's credentials: set `baseUrl` to the API origin if the document is served by the API, or `docAuth: true` to send them regardless.";
    throw new Error(`OpenAPI document ${c.url} → ${res.status}.${hint}`);
  }
  return (await res.json()) as OpenApiDoc;
}

async function connectOpenapi(c: OpenapiConnection): Promise<AnyAction[]> {
  const doc = await fetchOpenapiDoc(c);
  const baseUrl = (c.baseUrl ?? doc.servers?.[0]?.url ?? new URL(c.url).origin).replace(/\/$/, "");

  // Collect every operation first: ids are assigned for the whole list at once
  // (see toolIds), then the actions are defined.
  const pending: { opName: string; build: (id: string) => AnyAction }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const pathItem = inline(doc, item) as Json;
    // Path-level parameters apply to every operation; an operation's own
    // parameter with the same (name, in) overrides one.
    const shared = ((pathItem.parameters as Parameter[] | undefined) ?? []).filter((p) => p && p.name && p.in);
    for (const [method, raw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue; // "parameters", "summary", "servers", …
      const op = raw as Operation;
      const meta: OpenapiOperation = { method, path, tags: op.tags ?? [], ...(op.operationId ? { operationId: op.operationId } : {}) };
      if (!includes(c, meta)) continue;

      const own = (op.parameters ?? []).filter((p) => p && p.name && p.in);
      const params = [...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)), ...own].filter(
        (p) => p.in === "path" || p.in === "query" || p.in === "header", // cookie params: not supported
      );
      const properties: JsonSchema["properties"] = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name!] = property(p);
        if (p.required || p.in === "path") required.push(p.name!);
      }
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema as
        | { properties?: JsonSchema["properties"]; required?: string[] }
        | undefined;
      if (bodySchema?.properties) {
        Object.assign(properties, bodySchema.properties);
        for (const r of bodySchema.required ?? []) required.push(r);
      }

      const opName = op.operationId ?? `${method}_${path}`;
      pending.push({
        opName,
        build: (id) =>
          defineAction({
            id,
            description: `[${c.name}] ${op.summary ?? opName}`,
            input: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
            ...(c.requiresPrincipal ? { requiresPrincipal: true } : {}),
            run: async (input: Record<string, unknown>, ctx: ActionContext) => {
              let url = baseUrl + path;
              const query = new URLSearchParams();
              const headers = await resolveHeaders(c, ctx);
              const body: Record<string, unknown> = { ...input };
              for (const p of params) {
                const name = p.name!;
                if (!(name in input)) continue;
                const value = String(input[name]);
                if (p.in === "path") url = url.replace(`{${name}}`, encodeURIComponent(value));
                else if (p.in === "header") headers[name.toLowerCase()] = value;
                else query.set(name, value);
                delete body[name];
              }
              const qs = query.toString();
              if (qs) url += `?${qs}`;
              const init: RequestInit = { method: method.toUpperCase(), headers };
              if (method !== "get" && method !== "head" && bodySchema) init.body = JSON.stringify(body);
              const res = await fetch(url, init);
              const text = await res.text();
              // A non-2xx must not read as data: throw, so the model sees an error
              // with the status (and the start of the body), not a JSON blob.
              if (!res.ok) throw new Error(`${c.name}: ${init.method} ${path} failed (${res.status})${text ? `: ${text.slice(0, 500)}` : ""}`);
              if (!text) return null;
              try {
                return JSON.parse(text);
              } catch {
                return text;
              }
            },
          }),
      });
    }
  }
  const ids = toolIds(c.name, pending.map((p) => p.opName));
  const actions = pending.map((p, i) => p.build(ids[i]!));
  if (!c.include && actions.length > MANY_OPERATIONS) {
    console.warn(
      `[june] connection "${c.name}": ${actions.length} OpenAPI operations became tools, and every one is offered to the model on every turn. Narrow them with \`include\` (operationIds or tags).`,
    );
  }
  return actions;
}

// --- provider client (bring-your-own-transport) -------------------------------

async function connectProvider(c: ProviderConnection): Promise<AnyAction[]> {
  // Pass the gate INTO connect so the provider builds gated actions at
  // registration time (defineAction) — the only place that makes the Flight
  // server-reference fail closed too.
  const actions = await c.connect({ requiresPrincipal: c.requiresPrincipal });
  // Fail fast (never retro-mutate): if the connection demands a principal, every
  // tool must already be gated. A non-compliant provider is a bug, and mutating
  // here would leave the Flight path ungated while looking safe.
  if (c.requiresPrincipal) {
    for (const a of actions) {
      if (!a.requiresPrincipal) {
        throw new Error(
          `provider connection "${c.name}": requiresPrincipal is set but tool "${a.id}" was not built gated — thread the connect({ requiresPrincipal }) option into the tool's defineAction so it is gated at registration.`,
        );
      }
    }
  }
  return actions;
}

// --- discover all -------------------------------------------------------------

// A stable, human-readable URL label for the report — providers may omit `url`.
function reportUrl(c: Connection): string {
  return c.kind === "provider" ? (c.url ?? `provider:${c.name}`) : c.url;
}

// Connect every connection, collecting their tools. A down connection is
// reported with an `error` but never throws — one bad remote must not take the
// whole agent down.
//
// TRANSACTIONAL registration: connectMcp/connectOpenapi/connectProvider all
// register their tools GLOBALLY via defineAction (that is how June re-serves them
// from its own /mcp). If a connection fails partway — a provider that throws
// after registering some tools, or the provider gate-check rejecting an ungated
// tool — those already-registered actions would otherwise linger in
// ACTION_REGISTRY and stay reachable via /mcp and invokeAction even though the
// connection was "skipped". So each connection runs against an ENTRY snapshot and
// on failure we (a) delete the ids it added and (b) RESTORE any pre-existing
// entry it overwrote — so a failed connection that clobbered an existing id
// doesn't leave its action reachable under that id. (The Flight server reference
// is bound to its exact action — see agent.ts — so delete/restore both make the
// failed connection's reference inert while reviving the original's.)
//
// connectAll is SERIALIZED globally (per isolate): the ACTION_REGISTRY is shared,
// so two overlapping connectAll/agent-assembly runs could otherwise interleave
// registrations and a later failure's snapshot-diff would delete the OTHER run's
// tools. Serializing the (boot-time / first-turn) wiring makes each run's
// snapshot a faithful baseline. This is cheap: it's not a hot path, and separate
// isolates (Durable Objects) have separate registries anyway.
let connectAllQueue: Promise<unknown> = Promise.resolve();

export function connectAll(connections: Connection[]): Promise<{ actions: AnyAction[]; report: ConnectionReport[] }> {
  const run = () => connectAllImpl(connections);
  const result = connectAllQueue.then(run, run); // chain regardless of the prior run's outcome
  connectAllQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function connectAllImpl(connections: Connection[]): Promise<{ actions: AnyAction[]; report: ConnectionReport[] }> {
  const actions: AnyAction[] = [];
  const report: ConnectionReport[] = [];
  for (const c of connections) {
    const url = reportUrl(c);
    const before = new Map(ACTION_REGISTRY); // entry snapshot (ids AND their prior actions)
    try {
      const a = c.kind === "mcp" ? await connectMcp(c) : c.kind === "openapi" ? await connectOpenapi(c) : await connectProvider(c);
      actions.push(...a);
      report.push({ name: c.name, kind: c.kind, url, tools: a.map((x) => x.id) });
    } catch (e) {
      // Revert exactly this connection's registry changes: delete ids it added,
      // then restore any pre-existing entries it overwrote.
      for (const id of [...ACTION_REGISTRY.keys()]) if (!before.has(id)) ACTION_REGISTRY.delete(id);
      for (const [id, prev] of before) if (ACTION_REGISTRY.get(id) !== prev) ACTION_REGISTRY.set(id, prev);
      report.push({ name: c.name, kind: c.kind, url, tools: [], error: String(e) });
    }
  }
  return { actions, report };
}
