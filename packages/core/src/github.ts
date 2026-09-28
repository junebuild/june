// github.ts — GitHub App credentials: short-lived installation tokens, scoped per
// call to ONE repository and the permissions that call needs.
//
// An agent that works on code (clone, push, open PRs, comment) needs a GitHub
// credential. A personal access token is long-lived, tied to a person, and
// broader than any one call. A GitHub App installation token is the opposite —
// an hour at most, one repo, named permissions — but minting one is pure GitHub
// mechanics (an RS256 JWT, the installation lookup, the token exchange, caching)
// with nothing app-specific in it. So it lives here, once.
//
// June twist (identity, mirrored from connections.ts): `gh.auth(...)` plugs into
// the `auth: (ctx) => { token }` shape every connection and provider already
// takes — the token is resolved PER CALL, server-side, and never reaches the
// model. Pass a function to scope the token by the call's identity:
// `gh.auth((ctx) => ({ owner: tenantOf(ctx), repo, permissions }))`.
//
// WHERE THE TOKEN GOES is the caller's decision, and the one that matters most:
// never hand an installation token to an environment the model controls (a
// sandbox shell, an env var a tool can print, a git remote URL or credential
// helper inside that sandbox). Code running there can read it — from the
// environment, from a git hook, or through a replaced binary. Push on the
// model's behalf from outside that environment, or with the narrowest token.
//
// Pure + web-standard (fetch + WebCrypto RSASSA-PKCS1-v1_5/SHA-256, zero node:*),
// so it runs on the native host and on the edge alike.

import type { ActionContext } from "./context";

// A permission name (`contents`, `issues`, `pull_requests`, …) → access level,
// passed through to GitHub verbatim. Least privilege is the caller's policy —
// e.g. `read` to clone, `write` only after a human approves. An `undefined`
// entry is ignored, so `cond ? { issues: "write" } : { metadata: "read" }`
// (which TypeScript widens to optional-undefined keys) type-checks as-is.
export type GitHubPermissionLevel = "read" | "write" | "admin";
export type GitHubPermissions = Record<string, GitHubPermissionLevel | undefined>;

export type GitHubTokenRequest = {
  owner: string;
  repo: string;
  // Required and non-empty: an exchange without `permissions` returns a token
  // carrying EVERY permission the installation has, which is exactly the
  // over-broad credential this module exists to avoid.
  permissions: GitHubPermissions;
};

export type GitHubAppConfig = {
  // The App's numeric id or its client id (`Iv1.…`) — the JWT `iss`.
  appId: string | number;
  // PEM, PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub hands out) or PKCS#8
  // (`BEGIN PRIVATE KEY`). Literal `\n` escapes, CRLF, surrounding quotes and a
  // base64-wrapped PEM are all accepted — the common shapes secrets arrive in.
  privateKey: string;
  // GitHub Enterprise Server: `https://<host>/api/v3`. Default https://api.github.com.
  apiBaseUrl?: string;
  // GitHub rejects requests without a User-Agent (and edge runtimes send none).
  userAgent?: string;
  // Injectable for tests / custom transports. Defaults to the global fetch.
  fetch?: typeof fetch;
  // Epoch ms clock, injectable for tests. Defaults to Date.now.
  now?: () => number;
};

export type GitHubAuth = (ctx?: ActionContext) => Promise<{ token: string }>;

export type GitHubApp = {
  // A token for one repo with `permissions` (plus, possibly, read-only
  // `metadata`, which GitHub makes mandatory for any App with repository
  // access — the grant check only ever compares the names asked for). Cached per
  // (owner, repo, permissions) until 5 minutes before it expires; concurrent
  // calls for the same key share one exchange.
  token(req: GitHubTokenRequest): Promise<string>;
  // The same, as a connection/provider `auth`. A function form receives the
  // call's ActionContext (undefined at connection discovery time).
  auth(req: GitHubTokenRequest | ((ctx?: ActionContext) => GitHubTokenRequest | Promise<GitHubTokenRequest>)): GitHubAuth;
  // Drop a cached token and its repo's cached installation id (e.g. after GitHub
  // answered 401 to the token — revoked, or the installation's permissions
  // changed). Without an argument, drops everything cached.
  invalidate(req?: GitHubTokenRequest): void;
};

export type GitHubAppErrorCode =
  | "invalid_key" // the private key could not be parsed or imported
  | "invalid_request" // bad owner/repo/permissions before any network call
  | "not_installed" // the App is not installed on owner/repo (a public repo can still be read anonymously)
  | "permission_denied" // the App lacks a requested permission, or GitHub granted less than asked
  | "unauthorized" // GitHub rejected the App JWT (wrong appId, wrong key, clock skew)
  | "rate_limited" // a primary or secondary rate limit — transient; see `retryAfter`
  | "network" // fetch itself failed (DNS, connection, TLS) — `cause` holds the original
  | "http"; // any other non-2xx answer, or a 2xx whose body isn't what GitHub documents

export class GitHubAppError extends Error {
  readonly code: GitHubAppErrorCode;
  readonly status?: number;
  // Seconds to wait before retrying, when GitHub said (rate_limited only).
  readonly retryAfter?: number;
  constructor(code: GitHubAppErrorCode, message: string, opts: { status?: number; retryAfter?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GitHubAppError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
  }
}

const DEFAULT_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
// The JWT: backdated 60 s for clock skew, 9 min ahead — a 10-minute window,
// GitHub's maximum. Reused until a minute before it expires.
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;
const JWT_REUSE_MARGIN_S = 60;
// An installation token is dropped this long before its `expires_at`, so a
// caller never receives one that dies mid-operation.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// A repo's installation id is stable, but it is kept no longer than a token so
// a long-lived host serving many tenants holds at most the repos it touched in
// the last hour (expired entries are swept on every mint).
const INSTALLATION_TTL_MS = 60 * 60 * 1000;
const LEVELS = new Set(["read", "write", "admin"]);

// --- key handling --------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// DER length octets: short form below 128, else 0x80|n followed by n bytes.
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo, which is all WebCrypto imports:
//   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 }
const RSA_ALGORITHM_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLength = 3 + RSA_ALGORITHM_ID.length + octet.length + pkcs1.length;
  const header = [0x30, ...derLength(bodyLength), 0x02, 0x01, 0x00, ...RSA_ALGORITHM_ID, ...octet];
  const out = new Uint8Array(header.length + pkcs1.length);
  out.set(header, 0);
  out.set(pkcs1, header.length);
  return out;
}

// Normalize a PEM as it arrives through env vars / secret stores, and return
// its PKCS#8 DER. Never echoes key material into an error.
function pemToPkcs8(input: string): Uint8Array<ArrayBuffer> {
  let pem = input.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) pem = pem.slice(1, -1).trim();
  pem = pem.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r\n?/g, "\n");
  if (!pem.includes("-----BEGIN") && /^[A-Za-z0-9+/=\s]+$/.test(pem)) {
    // A whole PEM, base64-encoded once more (some platforms store secrets so).
    try {
      const decoded = atob(pem.replace(/\s+/g, ""));
      if (decoded.includes("-----BEGIN")) pem = decoded.trim().replace(/\r\n?/g, "\n");
    } catch {
      /* not base64 — fall through to the "no PEM block" error */
    }
  }
  const m = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new GitHubAppError("invalid_key", "GitHub App private key: no PEM block found (expected -----BEGIN RSA PRIVATE KEY----- or -----BEGIN PRIVATE KEY-----).");
  const label = m[1]!;
  if (label === "ENCRYPTED PRIVATE KEY" || /Proc-Type:\s*4,ENCRYPTED/.test(m[2]!)) {
    throw new GitHubAppError("invalid_key", "GitHub App private key is encrypted — decrypt it before passing it in.");
  }
  if (label !== "RSA PRIVATE KEY" && label !== "PRIVATE KEY") {
    throw new GitHubAppError("invalid_key", `GitHub App private key: unsupported PEM type "${label}" (expected RSA PRIVATE KEY or PRIVATE KEY).`);
  }
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = base64ToBytes(m[2]!.replace(/\s+/g, ""));
  } catch {
    throw new GitHubAppError("invalid_key", "GitHub App private key: the PEM body is not valid base64.");
  }
  return label === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(der) : der;
}

async function importSigningKey(privateKey: string): Promise<CryptoKey> {
  const der = pemToPkcs8(privateKey);
  try {
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GitHubAppError("invalid_key", "GitHub App private key could not be imported as an RSA key (is it an RSA key, and complete?).");
  }
}

// --- the App -------------------------------------------------------------------

// Canonical cache key: owner/repo are case-insensitive on GitHub, and
// permission key order must not split one scope into two entries. JSON of the
// sorted pairs is unambiguous whatever the names contain (validate() also
// restricts them), so two different scopes can never share a cached token.
function cacheKey(req: GitHubTokenRequest): string {
  const perms = Object.keys(req.permissions)
    .sort()
    .map((k) => [k, req.permissions[k]]);
  return JSON.stringify([req.owner.toLowerCase(), req.repo.toLowerCase(), perms]);
}

function repoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function snapshot(req: GitHubTokenRequest): GitHubTokenRequest {
  if (!req || typeof req !== "object") return req;
  const { owner, repo, permissions } = req;
  const copy =
    permissions && typeof permissions === "object"
      ? Object.freeze(Object.fromEntries(Object.entries(permissions).filter(([, level]) => level !== undefined)))
      : permissions;
  return Object.freeze({ owner, repo, permissions: copy });
}

// GitHub's owner/repo alphabet. "." and ".." pass it but are dot segments a URL
// parser would normalize away (/repos/acme/../installation → /repos/installation),
// and GitHub reserves both, so they are rejected outright.
function validName(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_.-]+$/.test(v) && v !== "." && v !== "..";
}

function validate(req: GitHubTokenRequest): void {
  if (!req || !validName(req.owner)) {
    throw new GitHubAppError("invalid_request", `GitHub App token: invalid owner ${JSON.stringify(req?.owner)}.`);
  }
  if (!validName(req.repo)) {
    throw new GitHubAppError("invalid_request", `GitHub App token: invalid repo ${JSON.stringify(req.repo)}.`);
  }
  const perms = req.permissions;
  if (!perms || typeof perms !== "object" || Object.keys(perms).length === 0) {
    throw new GitHubAppError(
      "invalid_request",
      "GitHub App token: `permissions` is required and must name at least one permission — without it GitHub grants every permission the installation has.",
    );
  }
  for (const [k, v] of Object.entries(perms)) {
    // Every GitHub App permission name is snake_case (contents, pull_requests, …).
    if (!/^[a-z_]+$/.test(k)) throw new GitHubAppError("invalid_request", `GitHub App token: invalid permission name ${JSON.stringify(k)}.`);
    if (v === undefined || !LEVELS.has(v)) throw new GitHubAppError("invalid_request", `GitHub App token: permission ${k} has invalid level ${JSON.stringify(v)} (read, write or admin).`);
  }
}

type CachedToken = { token: string; refreshAt: number };

export function githubApp(config: GitHubAppConfig): GitHubApp {
  const api = (config.apiBaseUrl ?? DEFAULT_API).replace(/\/$/, "");
  const now = config.now ?? Date.now;
  // Called through a closure, never as a detached method: workerd's fetch throws
  // "Illegal invocation" when invoked with a foreign `this`.
  const doFetch = (url: string, init: RequestInit) => (config.fetch ?? fetch)(url, init);
  // A numeric App id goes into the JWT as a number, a client id as a string.
  const iss = typeof config.appId === "number" || /^\d+$/.test(config.appId) ? Number(config.appId) : config.appId;
  const userAgent = config.userAgent ?? "june-github-app";

  let signingKey: Promise<CryptoKey> | undefined;
  let jwt: { value: string; reuseUntil: number } | undefined;
  const installations = new Map<string, { id: number; until: number }>(); // owner/repo → installation id
  const tokens = new Map<string, CachedToken>();
  const inflight = new Map<string, Promise<string>>();

  async function appJwt(): Promise<string> {
    const nowS = Math.floor(now() / 1000);
    if (jwt && nowS < jwt.reuseUntil) return jwt.value;
    signingKey ??= importSigningKey(config.privateKey);
    const key = await signingKey;
    const enc = new TextEncoder();
    const header = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const exp = nowS + JWT_LIFETIME_S;
    const payload = base64url(enc.encode(JSON.stringify({ iat: nowS - JWT_BACKDATE_S, exp, iss })));
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${payload}`)));
    const value = `${header}.${payload}.${base64url(signature)}`;
    jwt = { value, reuseUntil: exp - JWT_REUSE_MARGIN_S };
    return value;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await appJwt()}`,
      "user-agent": userAgent,
      "x-github-api-version": API_VERSION,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await doFetch(`${api}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      throw new GitHubAppError("network", `GitHub ${method} ${path} could not be reached: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }

  // A 2xx body that isn't JSON is GitHub (or a proxy in front of it) answering
  // something other than the documented API: a typed failure, never a SyntaxError.
  async function json(res: Response, what: string): Promise<Record<string, unknown>> {
    try {
      const body = await res.json();
      if (body && typeof body === "object") return body as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    throw new GitHubAppError("http", `GitHub ${what}: the ${res.status} response is not the documented JSON object.`, { status: res.status });
  }

  // GitHub's error envelope is { message, documentation_url }; surface the
  // message so logs say WHY. Response bodies never contain our credentials.
  async function detail(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { message?: string };
      return body?.message ? `: ${body.message}` : "";
    } catch {
      return "";
    }
  }

  // GitHub signals a PRIMARY rate limit with x-ratelimit-remaining: 0, and a
  // SECONDARY one with 403/429 plus retry-after and/or a "secondary rate limit"
  // message (the remaining header may be nonzero or absent). Both are transient.
  function rateLimit(res: Response, why: string): { retryAfter?: number } | null {
    if (res.status !== 403 && res.status !== 429) return null;
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    const limited =
      res.status === 429 || retryAfter !== null || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(why);
    if (!limited) return null;
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) return { retryAfter: Number(retryAfter) };
    if (reset !== null && /^\d+$/.test(reset)) return { retryAfter: Math.max(0, Number(reset) - Math.floor(now() / 1000)) };
    return {};
  }

  async function failure(res: Response, what: string, owner: string, repo: string): Promise<GitHubAppError> {
    const why = await detail(res);
    const status = res.status;
    if (status === 401) {
      return new GitHubAppError("unauthorized", `GitHub rejected the App JWT while ${what} (401)${why} — check appId, the private key, and the host clock.`, { status });
    }
    const limited = rateLimit(res, why);
    if (limited) return new GitHubAppError("rate_limited", `GitHub rate-limited ${what} for ${owner}/${repo} (${status})${why}`, { status, ...limited });
    // 422, or a 403 that isn't rate limiting: the App lacks a requested
    // permission, or the installation is suspended.
    if (status === 422 || status === 403) {
      return new GitHubAppError("permission_denied", `GitHub refused ${what} for ${owner}/${repo} (${status})${why}`, { status });
    }
    return new GitHubAppError("http", `GitHub ${what} for ${owner}/${repo} failed (${status})${why}`, { status });
  }

  async function installationId(owner: string, repo: string): Promise<number> {
    const key = repoKey(owner, repo);
    const cached = installations.get(key);
    if (cached && now() < cached.until) return cached.id;
    const res = await call("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
    if (res.status === 404) {
      throw new GitHubAppError("not_installed", `The GitHub App isn't installed on ${owner}/${repo} (or the repository doesn't exist).`, { status: 404 });
    }
    if (!res.ok) throw await failure(res, "the installation lookup", owner, repo);
    const { id } = await json(res, "installation lookup");
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      throw new GitHubAppError("http", `GitHub installation lookup for ${owner}/${repo} returned no installation id.`, { status: res.status });
    }
    installations.set(key, { id, until: now() + INSTALLATION_TTL_MS });
    return id;
  }

  async function exchange(req: GitHubTokenRequest, retried = false): Promise<{ token: string; expiresAt: number }> {
    const id = await installationId(req.owner, req.repo);
    const res = await call("POST", `/app/installations/${id}/access_tokens`, { repositories: [req.repo], permissions: req.permissions });
    if (res.status === 404 && !retried) {
      // The installation went away (uninstalled / reinstalled under a new id):
      // forget the cached id and look it up once more.
      installations.delete(repoKey(req.owner, req.repo));
      return exchange(req, true);
    }
    if (!res.ok) throw await failure(res, "the installation token exchange", req.owner, req.repo);
    const body = await json(res, "installation token exchange");
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (typeof body.token !== "string" || body.token === "" || !Number.isFinite(expiresAt)) {
      throw new GitHubAppError("http", `GitHub's installation token response for ${req.owner}/${req.repo} lacks a token or a valid expires_at.`, {
        status: res.status,
      });
    }
    const grantedPerms = (body.permissions && typeof body.permissions === "object" ? body.permissions : {}) as Record<string, unknown>;
    // Fail closed if GitHub granted less than was asked (it normally answers 422
    // instead): a caller must never believe it holds a scope it does not.
    for (const [perm, level] of Object.entries(req.permissions)) {
      const granted = grantedPerms[perm];
      if (granted !== level) {
        throw new GitHubAppError(
          "permission_denied",
          `GitHub granted ${perm}:${typeof granted === "string" ? granted : "none"} for ${req.owner}/${req.repo}, not the requested ${perm}:${level}.`,
        );
      }
    }
    return { token: body.token, expiresAt };
  }

  function sweep(t: number): void {
    for (const [k, v] of tokens) if (t >= v.refreshAt) tokens.delete(k);
    for (const [k, v] of installations) if (t >= v.until) installations.delete(k);
  }

  function token(input: GitHubTokenRequest): Promise<string> {
    // Snapshot the caller's request synchronously, reading each field once, and
    // work only from the copy: the exchange runs after an await, and a caller
    // mutating `permissions` meanwhile must not mint a broader token that then
    // gets cached under the narrower key computed here.
    let req: GitHubTokenRequest;
    try {
      req = snapshot(input);
      validate(req);
    } catch (e) {
      return Promise.reject(e);
    }
    const key = cacheKey(req);
    const hit = tokens.get(key);
    if (hit && now() < hit.refreshAt) return Promise.resolve(hit.token);
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = exchange(req)
      .then(({ token, expiresAt }) => {
        const t = now();
        sweep(t);
        const refreshAt = expiresAt - TOKEN_REFRESH_MARGIN_MS;
        // A token already inside the refresh margin (clock skew) is still handed
        // to THIS caller, just never cached.
        if (t < refreshAt) tokens.set(key, { token, refreshAt });
        return token;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    token,
    auth(req) {
      return async (ctx) => ({ token: await token(typeof req === "function" ? await req(ctx) : req) });
    },
    invalidate(req) {
      if (!req) {
        tokens.clear();
        installations.clear();
        return;
      }
      // Normalize exactly as token() does, so the key matches the cached one
      // (undefined permission entries dropped). A request token() would reject
      // was never cached — nothing to drop.
      const normalized = snapshot(req);
      try {
        validate(normalized);
      } catch {
        return;
      }
      tokens.delete(cacheKey(normalized));
      installations.delete(repoKey(normalized.owner, normalized.repo));
    },
  };
}
