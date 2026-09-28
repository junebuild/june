// mcp-client.ts — June's MCP client over Streamable HTTP, modern era first
// (2026-07-28), legacy (2025-11-25 and earlier) as the fallback.
//
// Era detection (spec 2026-07-28, transports: Backward Compatibility; mirrors
// the official SDK's probe classifier): the first contact is a modern
// `server/discover`. A DiscoverResult offering 2026-07-28 → modern. Anything a
// legacy server plausibly answers — an unrecognised result, a JSON-RPC error
// other than a -32022 that lists a modern version, a 4xx without a recognised
// modern error, a non-JSON body — → legacy, and the client runs the
// `initialize` handshake. 401/403, 5xx and network failures are errors, never a
// reason to downgrade. The verdict is kept for the client's lifetime.
//
// Legacy: `initialize` (offering 2025-11-25; the server may answer 2025-06-18 or
// 2025-03-26), `notifications/initialized`, then every request carries
// MCP-Protocol-Version and the Mcp-Session-Id the server minted (a 404 on it
// re-initialises once). Modern: every request carries the `_meta` envelope and
// mirrors MCP-Protocol-Version / Mcp-Method / Mcp-Name / Mcp-Param-* headers;
// there is no session. Both eras accept JSON or SSE responses.
//
// The client declares NO capabilities, so a modern server may not send it
// input requests (MRTR); a requestState-only `input_required` is retried (echoing
// the state) a bounded number of times.

import {
  encodeHeaderValue,
  ERROR,
  HEADER,
  LEGACY_PROTOCOL_VERSIONS,
  LATEST_LEGACY_PROTOCOL_VERSION,
  META,
  MODERN_PROTOCOL_VERSION,
  NAME_SOURCE,
  readSse,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./mcp-protocol";

export type McpEra = { kind: "modern"; version: string } | { kind: "legacy"; version: string };

export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly status?: number;
  // An SSE response stream that "ended" before the response, or failed while
  // being read ("reset" — a network error, never a reason to downgrade).
  readonly broken?: "ended" | "reset";
  constructor(message: string, code: number, opts: { data?: unknown; status?: number; broken?: "ended" | "reset" } = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    if (opts.data !== undefined) this.data = opts.data;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.broken !== undefined) this.broken = opts.broken;
  }
}

export type McpClientOptions = {
  url: string;
  // Resolves the headers for one request — static headers plus a per-call
  // credential (connections resolve `auth(ctx)` here).
  headers: () => Promise<Record<string, string>> | Record<string, string>;
  clientInfo?: { name: string; version: string };
  fetch?: typeof fetch;
};

const MAX_INPUT_REQUIRED_ROUNDS = 3;
// A broken modern response stream is re-issued (spec MUST) at most this often.
const MAX_STREAM_REISSUES = 2;
// Legacy sessions kept per credential; the oldest is dropped beyond this.
const MAX_LEGACY_SESSIONS = 256;
const ACCEPT = "application/json, text/event-stream";

type LegacySession = { version: string; sessionId?: string };

// A legacy session belongs to the credential that opened it: a per-tenant
// `auth(ctx)` must never ride on another tenant's (or discovery's) session. The
// key is every resolved header — Authorization, API keys, cookies alike.
function credentialKey(headers: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(headers)
      .map(([k, v]) => [k.toLowerCase(), v])
      .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)),
  );
}

// A DiscoverResult (spec 2026-07-28, server/discover): supportedVersions (all
// strings, offering the version June speaks) and a capabilities object. Anything
// else from the probe is a legacy or unrecognised peer, never a modern one.
// resultType / ttlMs / cacheScope are required of servers but tolerated absent.
function isDiscoverResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const { supportedVersions, capabilities } = result as { supportedVersions?: unknown; capabilities?: unknown };
  return (
    Array.isArray(supportedVersions) &&
    supportedVersions.every((v) => typeof v === "string") &&
    supportedVersions.includes(MODERN_PROTOCOL_VERSION) &&
    !!capabilities &&
    typeof capabilities === "object" &&
    !Array.isArray(capabilities)
  );
}

export class McpClient {
  private readonly opts: McpClientOptions;
  private readonly clientInfo: { name: string; version: string };
  private era: McpEra | undefined;
  private connecting: Promise<McpEra> | undefined;
  private readonly sessions = new Map<string, Promise<LegacySession>>();
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.opts = opts;
    this.clientInfo = opts.clientInfo ?? { name: "june", version: "0.0.0" };
  }

  get negotiated(): McpEra | undefined {
    return this.era;
  }

  // Probe once; concurrent callers share the probe.
  connect(): Promise<McpEra> {
    if (this.era) return Promise.resolve(this.era);
    this.connecting ??= this.probe().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  // Send one request in the negotiated era; returns its result (a modern
  // result's `resultType`/`_meta` are left in place for the caller to ignore).
  // `headers` resolves per call so a per-tenant credential can be used.
  async request(
    method: string,
    params: Record<string, unknown> = {},
    opts: { headers?: () => Promise<Record<string, string>> | Record<string, string>; extraHeaders?: Record<string, string> } = {},
  ): Promise<Record<string, unknown>> {
    const era = await this.connect();
    const base = await (opts.headers ?? this.opts.headers)();
    if (era.kind === "modern") return this.modernRequest(method, params, base, opts.extraHeaders ?? {});
    return this.legacyRequest(method, params, base, true);
  }

  // --- era detection -------------------------------------------------------------

  private async probe(retried = false): Promise<McpEra> {
    const headers = await this.opts.headers();
    const id = this.id();
    const res = await this.post(this.modernBody(id, "server/discover", {}), { ...headers, ...this.modernHeaders("server/discover", {}) });
    if (res.status === 401 || res.status === 403) {
      throw new McpError(`MCP ${this.opts.url}: server/discover was refused (${res.status}) — check the connection's credentials.`, ERROR.internal, { status: res.status });
    }
    if (res.status >= 500) throw new McpError(`MCP ${this.opts.url}: server/discover failed (${res.status}).`, ERROR.internal, { status: res.status });
    // A body that isn't a JSON-RPC response (HTML, empty, an SSE stream without
    // one) is classified — readMessage reports those as McpError. A failure to
    // READ the body (a reset mid-response) is a network error: it propagates,
    // never a reason to downgrade.
    const message = await this.readMessage(res, id).catch((e) => {
      if (e instanceof McpError && e.broken !== "reset") return undefined;
      throw e;
    });
    if (message?.result && isDiscoverResult(message.result)) {
      this.era = { kind: "modern", version: MODERN_PROTOCOL_VERSION };
      return this.era;
    }
    if (message?.error?.code === ERROR.unsupportedProtocolVersion) {
      const supported = (message.error.data as { supported?: unknown } | undefined)?.supported;
      // The server lists the version June offered: a modern server that rejected
      // this request for another reason. The client SHOULD retry with a mutually
      // supported version — re-probe once (as the official SDK does); a second
      // rejection is an error, not a downgrade.
      if (Array.isArray(supported) && supported.includes(MODERN_PROTOCOL_VERSION)) {
        if (retried) throw new McpError(`MCP ${this.opts.url}: server/discover rejected ${MODERN_PROTOCOL_VERSION} twice although the server lists it.`, ERROR.unsupportedProtocolVersion, { data: message.error.data });
        return this.probe(true);
      }
      // A modern server that doesn't speak 2026-07-28 but some other modern revision:
      // falling back to initialize would be wrong — and there's nothing June can offer.
      if (Array.isArray(supported) && supported.some((v) => typeof v === "string" && v >= MODERN_PROTOCOL_VERSION) && !supported.some((v) => (LEGACY_PROTOCOL_VERSIONS as readonly unknown[]).includes(v))) {
        throw new McpError(`MCP ${this.opts.url}: the server supports ${supported.join(", ")}; June speaks ${MODERN_PROTOCOL_VERSION} and ${LEGACY_PROTOCOL_VERSIONS.join(", ")}.`, ERROR.unsupportedProtocolVersion, { data: message.error.data });
      }
    }
    // Legacy: the discovery credential's handshake settles the era; its session
    // is kept for that credential only.
    const session = this.handshake(headers);
    this.remember(credentialKey(headers), session);
    this.era = { kind: "legacy", version: (await session).version };
    return this.era;
  }

  // initialize → notifications/initialized, for one credential.
  private async handshake(headers: Record<string, string>): Promise<LegacySession> {
    const id = this.id();
    const body = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
    };
    const res = await this.post(body, headers);
    const message = await this.readMessage(res, id);
    if (message.error) throw new McpError(`MCP ${this.opts.url}: initialize failed: ${message.error.message}`, message.error.code, { data: message.error.data, status: res.status });
    const version = (message.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (typeof version !== "string" || !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      throw new McpError(`MCP ${this.opts.url}: the server negotiated protocol version ${JSON.stringify(version)}, which June does not speak (${[MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS].join(", ")}).`, ERROR.unsupportedProtocolVersion);
    }
    const sessionId = res.headers.get(HEADER.session) ?? undefined;
    const session: LegacySession = { version, ...(sessionId ? { sessionId } : {}) };
    // The lifecycle MUST: announce readiness before any other request.
    const ack = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...headers, ...this.legacyHeaders(session) });
    await ack.body?.cancel();
    if (!ack.ok) throw new McpError(`MCP ${this.opts.url}: notifications/initialized was refused (${ack.status}).`, ERROR.internal, { status: ack.status });
    return session;
  }

  private remember(key: string, session: Promise<LegacySession>): void {
    if (!this.sessions.has(key) && this.sessions.size >= MAX_LEGACY_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value!);
    }
    this.sessions.set(key, session);
    // A failed handshake must not poison the credential: the next call retries.
    session.catch(() => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
  }

  // --- legacy ---------------------------------------------------------------------

  private legacyHeaders(session: LegacySession): Record<string, string> {
    return {
      // 2025-03-26 predates the header; later revisions require it.
      ...(session.version >= "2025-06-18" ? { [HEADER.protocolVersion]: session.version } : {}),
      ...(session.sessionId ? { [HEADER.session]: session.sessionId } : {}),
    };
  }

  private async legacyRequest(method: string, params: Record<string, unknown>, headers: Record<string, string>, mayRestart: boolean): Promise<Record<string, unknown>> {
    const key = credentialKey(headers);
    let pending = this.sessions.get(key);
    if (!pending) {
      pending = this.handshake(headers);
      this.remember(key, pending);
    }
    const session = await pending;
    const id = this.id();
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, { ...headers, ...this.legacyHeaders(session) });
    // The session expired: forget it, start a new one (without the old id) and retry once.
    if (res.status === 404 && session.sessionId && mayRestart) {
      await res.body?.cancel();
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
      return this.legacyRequest(method, params, headers, false);
    }
    // A 2025-era server may send requests on the response stream before the
    // response (ping, or methods needing capabilities June never declared).
    const message = await this.readMessage(res, id, (m) => this.answer(m, headers, session));
    return this.result(method, res, message);
  }

  // Answer a server-to-client request that arrived on a legacy SSE stream: ping
  // MUST be answered promptly; anything else needs a capability June's client
  // doesn't declare → method not found. Notifications and responses are ignored.
  private async answer(message: JsonRpcMessage, headers: Record<string, string>, session: LegacySession): Promise<void> {
    if (typeof message.method !== "string" || message.id === undefined || message.id === null) return;
    const reply =
      message.method === "ping"
        ? { jsonrpc: "2.0", id: message.id, result: {} }
        : { jsonrpc: "2.0", id: message.id, error: { code: ERROR.methodNotFound, message: `Method not found: ${message.method} (June's MCP client declares no capabilities)` } };
    try {
      const res = await this.post(reply, { ...headers, ...this.legacyHeaders(session) });
      await res.body?.cancel();
    } catch {
      /* the server will time the request out; the response we await still decides the call */
    }
  }

  // --- modern ---------------------------------------------------------------------

  private modernBody(id: JsonRpcId, method: string, params: Record<string, unknown>) {
    const meta = (params._meta as Record<string, unknown> | undefined) ?? {};
    return {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          ...meta,
          [META.protocolVersion]: MODERN_PROTOCOL_VERSION,
          [META.clientInfo]: this.clientInfo,
          [META.clientCapabilities]: {},
        },
      },
    };
  }

  private modernHeaders(method: string, params: Record<string, unknown>): Record<string, string> {
    const source = NAME_SOURCE[method];
    const name = source ? params[source] : undefined;
    return {
      [HEADER.protocolVersion]: MODERN_PROTOCOL_VERSION,
      [HEADER.method]: method,
      ...(typeof name === "string" ? { [HEADER.name]: encodeHeaderValue(name) } : {}),
    };
  }

  // One modern request, re-issued with a NEW id when its SSE response stream
  // breaks (spec 2026-07-28 MUST: there is no resumption; the in-flight request
  // is lost). Remote tools are at-least-once already.
  private async modernOnce(method: string, params: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const id = this.id();
      const res = await this.post(this.modernBody(id, method, params), { ...headers, ...this.modernHeaders(method, params) });
      try {
        return await this.result(method, res, await this.readMessage(res, id));
      } catch (e) {
        if (e instanceof McpError && e.broken && attempt < MAX_STREAM_REISSUES) continue;
        throw e;
      }
    }
  }

  private async modernRequest(method: string, params: Record<string, unknown>, headers: Record<string, string>, extra: Record<string, string>): Promise<Record<string, unknown>> {
    let current = params;
    for (let round = 1; ; round++) {
      const result = await this.modernOnce(method, current, { ...headers, ...extra });
      const type = result.resultType ?? "complete"; // absent ⇒ complete (spec MUST)
      if (type === "complete") return result;
      if (type !== "input_required") throw new McpError(`MCP ${method}: unrecognised resultType ${JSON.stringify(type)}.`, ERROR.internal);
      if (result.inputRequests !== undefined) {
        throw new McpError(`MCP ${method}: the server asked for client input (${Object.keys(result.inputRequests as object).join(", ") || "input"}), which June's MCP client does not provide.`, ERROR.missingClientCapability, { data: result.inputRequests });
      }
      if (typeof result.requestState !== "string") throw new McpError(`MCP ${method}: input_required without inputRequests or requestState.`, ERROR.internal);
      if (round >= MAX_INPUT_REQUIRED_ROUNDS) throw new McpError(`MCP ${method}: still input_required after ${round} rounds.`, ERROR.internal);
      // Echo the opaque state verbatim on a retry with a NEW request id.
      current = { ...params, requestState: result.requestState };
    }
  }

  // --- transport ------------------------------------------------------------------

  private id(): number {
    return this.nextId++;
  }

  private async post(body: object, headers: Record<string, string>): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    return doFetch(this.opts.url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(body),
    });
  }

  // The JSON-RPC response to request `id`, from a JSON or an SSE body. A body
  // that is neither is an error; so is an SSE stream that ends without it
  // (broken "ended") or fails while being read (broken "reset").
  private async readMessage(res: Response, id: JsonRpcId, onOther?: (m: JsonRpcMessage) => void | Promise<void>): Promise<JsonRpcMessage> {
    // Streamable HTTP answers a request with exactly one of two media types
    // (parameters like `; charset=utf-8` aside). Anything else — text/plain,
    // text/html from a proxy, no Content-Type at all — is not an MCP response,
    // even when its body happens to parse as JSON.
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const matches = (m: JsonRpcMessage) => m.id === id && ("result" in m || "error" in m);
    if (type === "text/event-stream") {
      let message: JsonRpcMessage | undefined;
      try {
        message = res.body ? await readSse(res.body, matches, onOther) : undefined;
      } catch (e) {
        throw new McpError(`MCP ${this.opts.url}: the response stream for request ${id} broke: ${e instanceof Error ? e.message : String(e)}`, ERROR.internal, { status: res.status, broken: "reset" });
      }
      if (!message) throw new McpError(`MCP ${this.opts.url}: the response stream ended before the response to request ${id} (HTTP ${res.status}).`, ERROR.internal, { status: res.status, broken: "ended" });
      return message;
    }
    if (type !== "application/json") {
      await res.body?.cancel();
      throw new McpError(`MCP ${this.opts.url}: HTTP ${res.status} with Content-Type ${JSON.stringify(res.headers.get("content-type") ?? "(none)")}, not application/json or text/event-stream.`, ERROR.parse, { status: res.status });
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new McpError(`MCP ${this.opts.url}: HTTP ${res.status} with a non-JSON body${text ? `: ${text.slice(0, 200)}` : ""}.`, ERROR.parse, { status: res.status });
    }
    const found = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => m && typeof m === "object" && ((m as JsonRpcMessage).id === id || (m as JsonRpcMessage).id === null));
    if (!found) throw new McpError(`MCP ${this.opts.url}: HTTP ${res.status} without a response to request ${id}.`, ERROR.internal, { status: res.status });
    return found as JsonRpcMessage;
  }

  private async result(method: string, res: Response, message: JsonRpcMessage): Promise<Record<string, unknown>> {
    if (message.error) {
      throw new McpError(`${method}: ${message.error.message}`, message.error.code, { data: message.error.data, status: res.status });
    }
    return (message.result && typeof message.result === "object" ? message.result : {}) as Record<string, unknown>;
  }
}
