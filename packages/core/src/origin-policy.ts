// Which browsers may call the agent endpoints (/mcp, /api/<id>) — #308.
//
// Two attacks, two checks:
//   • A page on another site POSTs to the endpoint (CSRF). The browser always
//     sends `Origin` on a cross-origin POST, so a present Origin must be the
//     request's own origin or an allowed one. A request with NO Origin is not
//     from a browser (CLI, SDK, a server-side connector) and passes.
//   • DNS rebinding: the attacker's name resolves to 127.0.0.1, so the page IS
//     same-origin — the browser sends `Host: evil.com:3000`, and the request's
//     own origin is the attacker's. Only the Host header gives it away, so a
//     server that can be rebound (a local one) sets `allowedHosts`.
//
// MCP 2026-07-28, Streamable HTTP: "Servers MUST validate the Origin header on
// all incoming connections to prevent DNS rebinding attacks … If the Origin
// header is present and invalid, servers MUST respond with HTTP 403 Forbidden."

export type OriginPolicy = {
  // Origins allowed besides the request's own, e.g. "https://app.example.com".
  allowedOrigins?: readonly string[];
  // When set, the Host must be an IP literal (rebinding needs a domain name) or
  // match an entry: an exact name, or ".example.com" for it and its subdomains.
  // Unset = any Host (a public deployment, routed by its domain). `june dev`
  // sets ["localhost", ".localhost"].
  allowedHosts?: readonly string[];
};

// Why the request is refused, or undefined when the policy lets it through.
export function originRejection(request: Request, policy: OriginPolicy = {}): string | undefined {
  const own = new URL(request.url);
  if (policy.allowedHosts) {
    const host = request.headers.get("host") ?? own.host;
    const name = hostname(host);
    if (name === undefined || !(isIpLiteral(name) || policy.allowedHosts.some((h) => hostMatches(name, h)))) {
      return `Host "${host}" is not allowed — add it to agent.allowedHosts in june.config.ts`;
    }
  }
  const origin = request.headers.get("origin");
  if (origin === null || origin === own.origin) return undefined;
  if (policy.allowedOrigins?.some((o) => normalizeOrigin(o) === origin.toLowerCase())) return undefined;
  return `Origin "${origin}" is not allowed — add it to agent.allowedOrigins in june.config.ts`;
}

// CORS for a browser app on an allowed origin — without it, allowedOrigins
// would admit calls the browser then refuses to send (the preflight) or to
// read (the response). Only a cross-origin Origin the policy LISTS gets
// headers, echoing that validated value; same-origin calls need none.
// Credentials are allowed: listing an origin is trusting it with the
// visitor's session, the same trust the app's own pages have.
export function corsHeaders(request: Request, policy: OriginPolicy = {}): Record<string, string> | undefined {
  const origin = request.headers.get("origin");
  if (origin === null || origin === new URL(request.url).origin) return undefined;
  if (!policy.allowedOrigins?.some((o) => normalizeOrigin(o) === origin.toLowerCase())) return undefined;
  return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
}

// The answer to a CORS preflight (OPTIONS) from an allowed origin: POST, with
// whatever headers it asked for (the MCP ones include per-tool Mcp-Param-*).
export function preflightResponse(request: Request, cors: Record<string, string>): Response {
  const asked = request.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": "POST",
      ...(asked ? { "access-control-allow-headers": asked } : {}),
      "access-control-max-age": "600",
      vary: "Origin, Access-Control-Request-Headers",
    },
  });
}

// A handler's response with the CORS headers added (Vary appended, not replaced).
export function withCors(response: Response, cors: Record<string, string>): Response {
  for (const [name, value] of Object.entries(cors)) {
    if (name === "vary" && response.headers.has("vary")) response.headers.append("vary", value);
    else response.headers.set(name, value);
  }
  return response;
}

// The config's shape errors, so a bad entry fails the build instead of every request.
export function validateOriginPolicy(policy: OriginPolicy): void {
  for (const o of policy.allowedOrigins ?? []) {
    if (normalizeOrigin(o) === undefined) {
      throw new Error(`agent.allowedOrigins: "${o}" is not an origin — use scheme://host[:port], e.g. "https://app.example.com".`);
    }
  }
  for (const h of policy.allowedHosts ?? []) {
    const name = (h.startsWith(".") ? h.slice(1) : h).toLowerCase();
    if (!name || hostname(name) !== name) {
      throw new Error(`agent.allowedHosts: "${h}" is not a host name — use "example.com", or ".example.com" to include its subdomains (no scheme or port).`);
    }
  }
}

function hostname(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

// WHATWG URL parsing already canonicalized the name: IPv4 in dotted decimal
// (even "0x7f.1" or "2130706433"), IPv6 in brackets.
function isIpLiteral(name: string): boolean {
  return name.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

function hostMatches(name: string, entry: string): boolean {
  const e = entry.toLowerCase();
  return e.startsWith(".") ? name === e.slice(1) || name.endsWith(e) : name === e;
}

function normalizeOrigin(o: string): string | undefined {
  try {
    const url = new URL(o);
    return url.origin !== "null" && `${url.origin}/` === url.href.replace(/\/?$/, "/") ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
