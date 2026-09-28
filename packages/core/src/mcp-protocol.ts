// mcp-protocol.ts — the MCP wire rules June's client (connections.ts) and server
// (mcp.ts) share: protocol versions, the per-request `_meta` envelope, error
// codes, header-value encoding, `x-mcp-header` parameter mirroring, and an SSE
// reader for Streamable HTTP responses.
//
// Two protocol ERAS (spec 2026-07-28, basic/versioning):
//   modern  — 2026-07-28: stateless; every request carries its protocol version
//             and client capabilities in `params._meta` and mirrors routing
//             fields into headers (MCP-Protocol-Version, Mcp-Method, Mcp-Name);
//             `server/discover` replaces the initialize handshake.
//   legacy  — 2025-11-25 and earlier: an `initialize` handshake opens a session.
// June speaks modern first and falls back to legacy, so it interoperates with
// peers that haven't moved yet (the official SDK's default client is legacy).
//
// Web-standard (TextEncoder/TextDecoder, btoa/atob, ReadableStream) — no node:*.

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
// Legacy revisions June negotiates, newest first. 2025-03-26 is the first with
// Streamable HTTP; June does not speak the older HTTP+SSE transport.
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const LATEST_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

export const HEADER = {
  protocolVersion: "mcp-protocol-version",
  method: "mcp-method",
  name: "mcp-name",
  session: "mcp-session-id",
  paramPrefix: "mcp-param-",
} as const;

// Methods whose params.name / params.uri is mirrored into Mcp-Name.
export const NAME_SOURCE: Record<string, "name" | "uri"> = { "tools/call": "name", "resources/read": "uri", "prompts/get": "name" };

export type JsonRpcId = string | number;
export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// --- header value encoding (Base64 sentinel) ----------------------------------

// A header value is sent as-is only when it is visible ASCII (tab/space allowed
// inside, not at the ends) and doesn't itself look like the sentinel; anything
// else — non-ASCII, control characters, surrounding whitespace, empty — is sent
// as `=?base64?<b64 of UTF-8>?=` (spec 2026-07-28, transports: Value Encoding).
const PLAIN_HEADER_VALUE = /^[\x21-\x7e](?:[\x20\x21-\x7e\t]*[\x21-\x7e])?$/;
const SENTINEL = /^=\?base64\?(.*)\?=$/;

export function encodeHeaderValue(value: string): string {
  if (PLAIN_HEADER_VALUE.test(value) && !SENTINEL.test(value)) return value;
  let bin = "";
  for (const b of new TextEncoder().encode(value)) bin += String.fromCharCode(b);
  return `=?base64?${btoa(bin)}?=`;
}

// The inverse; undefined when a sentinel's payload isn't valid Base64/UTF-8.
export function decodeHeaderValue(value: string): string | undefined {
  const m = value.match(SENTINEL);
  if (!m) return value;
  try {
    const bin = atob(m[1]!);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// --- x-mcp-header: tool parameters mirrored into Mcp-Param-* headers ----------

export type HeaderParam = { header: string; path: string[]; type: "string" | "integer" | "boolean" };

// RFC 9110 token (1*tchar).
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRIMITIVE = new Set(["string", "integer", "boolean"]);

// Validate a tool's `x-mcp-header` annotations and return where each one reads
// its value. Every annotation must sit on a primitive (string/integer/boolean)
// property reachable from the root through `properties` keys only, carry a
// token name, and be unique case-insensitively; one bad annotation invalidates
// the TOOL, which a Streamable HTTP client MUST then drop from tools/list.
export function headerParams(inputSchema: unknown): { params: HeaderParam[] } | { error: string } {
  const params: HeaderParam[] = [];
  const seen = new Set<string>();
  let error: string | undefined;
  const visit = (node: unknown, trail: string[], reachable: boolean, path: string[]) => {
    if (error || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, [...trail, String(i)], false, path));
      return;
    }
    const obj = node as Record<string, unknown>;
    if ("x-mcp-header" in obj) {
      const name = obj["x-mcp-header"];
      const where = trail.join("/") || "(root)";
      if (!reachable || path.length === 0) error = `x-mcp-header at ${where} is not reachable from the root through "properties" only`;
      else if (typeof name !== "string" || !TOKEN.test(name)) error = `x-mcp-header at ${where} is not a valid header token: ${JSON.stringify(name)}`;
      else if (typeof obj.type !== "string" || !PRIMITIVE.has(obj.type)) error = `x-mcp-header "${name}" is on a ${JSON.stringify(obj.type)} property (string, integer or boolean only)`;
      else if (seen.has(name.toLowerCase())) error = `x-mcp-header "${name}" is used twice`;
      else {
        seen.add(name.toLowerCase());
        params.push({ header: name, path, type: obj.type as HeaderParam["type"] });
      }
      if (error) return;
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key === "properties" && reachable && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [prop, schema] of Object.entries(child as Record<string, unknown>)) {
          visit(schema, [...trail, "properties", prop], true, [...path, prop]);
        }
      } else {
        visit(child, [...trail, key], false, path);
      }
    }
  };
  visit(inputSchema, [], true, []);
  return error ? { error } : { params };
}

// The Mcp-Param-* headers for one call. Absent or null → header omitted.
export function headerParamValues(params: HeaderParam[], args: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const p of params) {
    let v: unknown = args;
    for (const key of p.path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    if (v === undefined || v === null) continue;
    let text: string;
    if (p.type === "string" && typeof v === "string") text = v;
    else if (p.type === "integer" && typeof v === "number" && Number.isSafeInteger(v)) text = String(v);
    else if (p.type === "boolean" && typeof v === "boolean") text = String(v);
    else throw new Error(`argument ${p.path.join(".")} must be a${p.type === "integer" ? " safe" : ""} ${p.type} (it is mirrored into the Mcp-Param-${p.header} header)`);
    headers[`${HEADER.paramPrefix}${p.header}`] = encodeHeaderValue(text);
  }
  return headers;
}

// Server side: the Mcp-Param-* headers of one tools/call must agree with the
// arguments (spec 2026-07-28: a value in the body with no header, a header that
// isn't valid Base64, or a disagreeing value → HeaderMismatch). Integers compare
// numerically ("42.0" = 42). A header for an argument the body doesn't carry
// disagrees too. Returns why they disagree, or undefined.
export function headerParamMismatch(params: HeaderParam[], args: unknown, headers: Headers): string | undefined {
  for (const p of params) {
    let v: unknown = args;
    for (const key of p.path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    const name = `Mcp-Param-${p.header}`;
    const raw = headers.get(`${HEADER.paramPrefix}${p.header}`);
    if (v === undefined || v === null) {
      if (raw !== null) return `${name} header is present but arguments.${p.path.join(".")} is not`;
      continue;
    }
    if (raw === null) return `${name} header is missing for arguments.${p.path.join(".")}`;
    const text = decodeHeaderValue(raw);
    if (text === undefined) return `${name} header is not a valid Base64 sentinel`;
    // Integers: both sides must be JS-safe (the spec's range for x-mcp-header
    // integers) — outside it, 9007199254740993 and …992 round to the same
    // double and would compare equal.
    const same =
      p.type === "integer"
        ? text.trim() !== "" && Number.isSafeInteger(v) && Number.isSafeInteger(Number(text)) && Number(text) === v
        : p.type === "boolean"
          ? text === String(v)
          : text === v;
    if (!same) return `${name} header '${text}' does not match arguments.${p.path.join(".")} '${String(v)}'`;
  }
  return undefined;
}

// --- SSE (text/event-stream) -----------------------------------------------------

// Read JSON-RPC messages from an SSE response body, per the WHATWG event-stream
// rules: CRLF / LF / CR line ends, `:` comments ignored, multi-line `data`
// joined with "\n", an event dispatched on a blank line, an empty-data event (the
// 2025-11-25 "priming" event) dropped, and a trailing event without its blank
// line discarded at end of stream. Stops as soon as `until` accepts a message;
// every other message is handed to `onOther` (awaited — a server may wait for
// the client's answer to a request, e.g. ping, before sending the response).
export async function readSse(
  body: ReadableStream<Uint8Array>,
  until: (message: JsonRpcMessage) => boolean,
  onOther?: (message: JsonRpcMessage) => void | Promise<void>,
): Promise<JsonRpcMessage | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let first = true;
  const dispatch = async (): Promise<JsonRpcMessage | undefined> => {
    const payload = data.join("\n");
    data = [];
    if (!payload) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return undefined; // not a JSON-RPC event
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!m || typeof m !== "object") continue;
      if (until(m as JsonRpcMessage)) return m as JsonRpcMessage;
      await onOther?.(m as JsonRpcMessage);
    }
    return undefined;
  };
  // Consume every complete line in the buffer. Mid-stream a trailing CR is held
  // back (its LF may be in the next chunk); at end of stream it is a line end.
  const lines = async (final: boolean): Promise<JsonRpcMessage | undefined> => {
    for (;;) {
      const m = buffer.match(final ? /\r\n|\n|\r/ : /\r\n|\n|\r(?=[^\n])/);
      if (!m || m.index === undefined) return undefined;
      const line = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      if (line === "") {
        const hit = await dispatch();
        if (hit) return hit;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let v = colon === -1 ? "" : line.slice(colon + 1);
      if (v.startsWith(" ")) v = v.slice(1);
      if (field === "data") data.push(v);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        return await lines(true); // an event still missing its blank line is discarded
      }
      buffer += decoder.decode(value, { stream: true });
      if (first) {
        buffer = buffer.replace(/^﻿/, "");
        first = false;
      }
      const hit = await lines(false);
      if (hit) return hit;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
