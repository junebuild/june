// github.test.ts — githubApp mints short-lived, per-repo installation tokens.
// Keys are generated in the test (PKCS#1 as GitHub hands them out, and PKCS#8);
// every JWT the module sends is verified against the public key. A small fake
// stands in for GitHub's two endpoints, and an injected clock drives the cache.

import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, invokeAction } from "@junejs/core/agent";
import { connectAll, defineMcpConnection } from "@junejs/core/connections";
import { githubApp, GitHubAppError, type GitHubAppConfig } from "@junejs/core/github";

function rsaKeys(modulusLength: number) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
  return {
    publicKey,
    pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
const k2048 = rsaKeys(2048);

type Seen = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Verify an RS256 JWT against the public key; return its header + payload.
function checkJwt(jwt: string, publicKey: KeyObject) {
  const [h, p, s] = jwt.split(".");
  expect(s).not.toMatch(/[=+/]/); // base64url, no padding
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, "base64url"));
  expect(ok).toBe(true);
  return { header: b64urlJson(h!), payload: b64urlJson(p!) };
}

// A fake GitHub: installations by owner/repo, a token per exchange. Tweak
// `responses` to force a status for a path.
function makeFakeGitHub(opts: { expiresInMs?: number; clock: () => number }) {
  const seen: Seen[] = [];
  const installed = new Map<string, number>([["acme/widgets", 42]]);
  const overrides = new Map<string, () => Response>();
  let minted = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", url, headers, body });
    const path = new URL(url).pathname.replace(/^\/api\/v3/, ""); // GHES prefix
    const override = overrides.get(path);
    if (override) return override();
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/))) {
      const id = installed.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (id === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ id });
    }
    if ((m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      minted++;
      const expires = new Date(opts.clock() + (opts.expiresInMs ?? 60 * 60 * 1000)).toISOString();
      return Response.json({ token: `ghs_token${minted}`, expires_at: expires, permissions: body?.permissions ?? {} }, { status: 201 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen, installed, overrides, minted: () => minted };
}

let clock = Date.parse("2026-09-28T00:00:00Z");
const now = () => clock;
beforeEach(() => {
  clock = Date.parse("2026-09-28T00:00:00Z");
});

function setup(extra: Partial<GitHubAppConfig> = {}, fakeOpts: { expiresInMs?: number } = {}) {
  const gh = makeFakeGitHub({ ...fakeOpts, clock: now });
  const app = githubApp({ appId: "12345", privateKey: k2048.pkcs1, fetch: gh.fetch, now, ...extra });
  return { gh, app };
}

const READ = { owner: "acme", repo: "widgets", permissions: { contents: "read" as const } };

describe("the App JWT", () => {
  test("is RS256, iss = appId (numeric), iat backdated 60 s, exp 9 min ahead, verifiable with the public key", async () => {
    const { gh, app } = setup();
    await app.token(READ);
    const auth = gh.seen[0]!.headers.authorization!;
    expect(auth).toStartWith("Bearer ");
    const { header, payload } = checkJwt(auth.slice(7), k2048.publicKey);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const nowS = Math.floor(clock / 1000);
    expect(payload).toEqual({ iat: nowS - 60, exp: nowS + 540, iss: 12345 });
  });

  test("a client id stays a string iss", async () => {
    const { gh, app } = setup({ appId: "Iv23liAbCdEf" });
    await app.token(READ);
    expect(checkJwt(gh.seen[0]!.headers.authorization!.slice(7), k2048.publicKey).payload.iss).toBe("Iv23liAbCdEf");
  });

  test("is reused across exchanges, and re-signed a minute before it expires", async () => {
    const { gh, app } = setup();
    await app.token(READ);
    await app.token({ ...READ, permissions: { issues: "write" } });
    const jwts = gh.seen.map((s) => s.headers.authorization);
    expect(new Set(jwts).size).toBe(1);
    clock += 8 * 60 * 1000; // exp - 60 s
    await app.token({ ...READ, permissions: { pull_requests: "read" } });
    expect(gh.seen.at(-1)!.headers.authorization).not.toBe(jwts[0]);
  });
});

describe("private key formats", () => {
  const cases: [string, (k: typeof k2048) => string][] = [
    ["PKCS#1 (GitHub's format)", (k) => k.pkcs1],
    ["PKCS#8", (k) => k.pkcs8],
    ["literal \\n escapes (env var)", (k) => k.pkcs1.replace(/\n/g, "\\n")],
    ["CRLF line endings", (k) => k.pkcs1.replace(/\n/g, "\r\n")],
    ["surrounding quotes and whitespace", (k) => `  "${k.pkcs1.replace(/\n/g, "\\n")}"  \n`],
    ["the whole PEM base64-encoded once more", (k) => Buffer.from(k.pkcs1).toString("base64")],
  ];
  for (const [name, shape] of cases) {
    test(`accepts ${name}`, async () => {
      const { gh, app } = setup({ privateKey: shape(k2048) });
      expect(await app.token(READ)).toBe("ghs_token1");
      checkJwt(gh.seen[0]!.headers.authorization!.slice(7), k2048.publicKey);
    });
  }

  test("a 4096-bit PKCS#1 key (longer DER length prefix) signs verifiably", async () => {
    const k4096 = rsaKeys(4096);
    const { gh, app } = setup({ privateKey: k4096.pkcs1 });
    await app.token(READ);
    checkJwt(gh.seen[0]!.headers.authorization!.slice(7), k4096.publicKey);
  });

  const bad: [string, string, RegExp][] = [
    ["garbage", "not a key", /no PEM block/],
    ["an encrypted PKCS#8 key", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----", /encrypted/],
    ["a public key", "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----", /unsupported PEM type "PUBLIC KEY"/],
    ["a truncated key", k2048.pkcs1.slice(0, 400) + "\n-----END RSA PRIVATE KEY-----", /could not be imported/],
  ];
  for (const [name, key, message] of bad) {
    test(`rejects ${name} with invalid_key, before any network call, without echoing the key`, async () => {
      const { gh, app } = setup({ privateKey: key });
      const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
      expect(err).toBeInstanceOf(GitHubAppError);
      expect(err.code).toBe("invalid_key");
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain("MIIB");
      expect(gh.seen).toHaveLength(0);
    });
  }
});

describe("the exchange", () => {
  test("looks up the installation, then narrows the token to one repo and the requested permissions", async () => {
    const { gh, app } = setup();
    expect(await app.token(READ)).toBe("ghs_token1");
    expect(gh.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/42/access_tokens",
    ]);
    expect(gh.seen[1]!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
  });

  test("sends GitHub's required headers (User-Agent — edge runtimes send none — Accept, API version)", async () => {
    const { gh, app } = setup({ userAgent: "my-app" });
    await app.token(READ);
    for (const s of gh.seen) {
      expect(s.headers["user-agent"]).toBe("my-app");
      expect(s.headers.accept).toBe("application/vnd.github+json");
      expect(s.headers["x-github-api-version"]).toBe("2022-11-28");
    }
    const { gh: gh2, app: app2 } = setup();
    await app2.token(READ);
    expect(gh2.seen[0]!.headers["user-agent"]).toBe("june-github-app");
  });

  test("apiBaseUrl targets GitHub Enterprise Server", async () => {
    const { gh, app } = setup({ apiBaseUrl: "https://ghe.example.com/api/v3/" });
    await app.token(READ);
    expect(gh.seen[0]!.url).toBe("https://ghe.example.com/api/v3/repos/acme/widgets/installation");
  });

  test("an App not installed on the repo is a distinguishable not_installed error", async () => {
    const { app } = setup();
    const err = (await app.token({ ...READ, repo: "other" }).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("not_installed");
    expect(err.status).toBe(404);
    expect(err.message).toContain("acme/other");
  });

  test("422 (permission the App lacks) is permission_denied and carries GitHub's message", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/app/installations/42/access_tokens", () =>
      Response.json({ message: "The permissions requested are not granted to this installation." }, { status: 422 }),
    );
    const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("permission_denied");
    expect(err.message).toContain("not granted to this installation");
  });

  const limits: [string, () => Response, number | undefined][] = [
    [
      "a primary limit (x-ratelimit-remaining: 0), retryAfter from x-ratelimit-reset",
      () =>
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(clock / 1000) + 120) } },
        ),
      120,
    ],
    [
      "a secondary limit: 403 + retry-after, remaining nonzero",
      () => Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403, headers: { "retry-after": "60", "x-ratelimit-remaining": "4000" } }),
      60,
    ],
    ["a secondary limit identified only by its message", () => Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }), undefined],
    ["a 429", () => Response.json({ message: "Too many requests" }, { status: 429, headers: { "retry-after": "5" } }), 5],
  ];
  for (const [name, respond, retryAfter] of limits) {
    test(`${name} is rate_limited, not permission_denied`, async () => {
      const { gh, app } = setup();
      gh.overrides.set("/app/installations/42/access_tokens", respond);
      const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfter).toBe(retryAfter);
    });
  }

  test("a rejected fetch (DNS, connection) is a typed network error carrying the cause", async () => {
    const cause = new TypeError("fetch failed");
    const app = githubApp({ appId: "12345", privateKey: k2048.pkcs1, now, fetch: (async () => Promise.reject(cause)) as never });
    const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
    expect(err).toBeInstanceOf(GitHubAppError);
    expect(err.code).toBe("network");
    expect(err.cause).toBe(cause);
    expect(err.message).not.toContain("eyJ"); // no JWT in the message
  });

  const malformed: [string, string, () => Response][] = [
    ["a non-JSON 200 installation lookup", "/repos/acme/widgets/installation", () => new Response("<html>proxy</html>", { status: 200 })],
    ["an installation lookup without an id", "/repos/acme/widgets/installation", () => Response.json({})],
    [
      "a token response without a token",
      "/app/installations/42/access_tokens",
      () => Response.json({ expires_at: new Date(clock + 3600_000).toISOString(), permissions: { contents: "read" } }, { status: 201 }),
    ],
    [
      "a token response with an unparseable expires_at",
      "/app/installations/42/access_tokens",
      () => Response.json({ token: "ghs_x", expires_at: "soon", permissions: { contents: "read" } }, { status: 201 }),
    ],
    ["a non-JSON 201 token response", "/app/installations/42/access_tokens", () => new Response("ok", { status: 201 })],
  ];
  for (const [name, path, respond] of malformed) {
    test(`${name} fails closed as a typed http error, and nothing is cached`, async () => {
      const { gh, app } = setup();
      gh.overrides.set(path, respond);
      const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
      expect(err).toBeInstanceOf(GitHubAppError);
      expect(err.code).toBe("http");
      gh.overrides.clear();
      expect(await app.token(READ)).toStartWith("ghs_token");
    });
  }

  test("401 means the JWT was rejected: unauthorized, pointing at appId/key/clock", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/repos/acme/widgets/installation", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("unauthorized");
    expect(err.message).toMatch(/appId.*clock/);
  });

  test("5xx is http with the status; a non-JSON body still yields a message", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/app/installations/42/access_tokens", () => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("http");
    expect(err.status).toBe(502);
  });

  test("GitHub's mandatory metadata:read alongside the requested scope is accepted", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/app/installations/42/access_tokens", () =>
      Response.json(
        { token: "ghs_meta", expires_at: new Date(clock + 3600_000).toISOString(), permissions: { contents: "read", metadata: "read" } },
        { status: 201 },
      ),
    );
    expect(await app.token(READ)).toBe("ghs_meta");
  });

  test("fails closed when GitHub grants less than was requested", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/app/installations/42/access_tokens", () =>
      Response.json({ token: "ghs_x", expires_at: new Date(clock + 3600_000).toISOString(), permissions: { contents: "read" } }, { status: 201 }),
    );
    const err = (await app.token({ ...READ, permissions: { contents: "write" } }).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("permission_denied");
    expect(err.message).toContain("contents:read");
    expect(err.message).not.toContain("ghs_x");
  });

  test("a reinstalled App (stale installation id → 404) is looked up again once", async () => {
    const { gh, app } = setup();
    await app.token(READ);
    gh.installed.set("acme/widgets", 77);
    gh.overrides.set("/app/installations/42/access_tokens", () => Response.json({ message: "Not Found" }, { status: 404 }));
    await app.token({ ...READ, permissions: { issues: "read" } });
    expect(gh.seen.slice(2).map((s) => new URL(s.url).pathname)).toEqual([
      "/app/installations/42/access_tokens",
      "/repos/acme/widgets/installation",
      "/app/installations/77/access_tokens",
    ]);
  });

  test("an installation 404 that persists after the re-lookup surfaces as an error, no loop", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/app/installations/42/access_tokens", () => Response.json({ message: "Not Found" }, { status: 404 }));
    const err = (await app.token(READ).catch((e) => e)) as GitHubAppError;
    expect(err.code).toBe("http");
    expect(gh.seen).toHaveLength(4);
  });

  const invalid: [string, object, RegExp][] = [
    ["missing permissions", { owner: "acme", repo: "widgets" }, /permissions.*required/],
    ["empty permissions", { owner: "acme", repo: "widgets", permissions: {} }, /permissions.*required/],
    ["permissions that are all undefined", { owner: "acme", repo: "widgets", permissions: { issues: undefined } }, /permissions.*required/],
    ["a bad level", { owner: "acme", repo: "widgets", permissions: { contents: "all" } }, /invalid level/],
    ["a path-injecting repo", { owner: "acme", repo: "../../app", permissions: { contents: "read" } }, /invalid repo/],
    ["a dot-segment repo", { owner: "acme", repo: "..", permissions: { contents: "read" } }, /invalid repo/],
    ["a dot-segment owner", { owner: ".", repo: "widgets", permissions: { contents: "read" } }, /invalid owner/],
    ["a permission name outside GitHub's snake_case", { owner: "acme", repo: "widgets", permissions: { "contents:read,issues": "write" } }, /invalid permission name/],
    ["an empty owner", { owner: "", repo: "widgets", permissions: { contents: "read" } }, /invalid owner/],
  ];
  for (const [name, req, message] of invalid) {
    test(`rejects ${name} as invalid_request before any network call`, async () => {
      const { gh, app } = setup();
      const err = (await app.token(req as never).catch((e) => e)) as GitHubAppError;
      expect(err.code).toBe("invalid_request");
      expect(err.message).toMatch(message);
      expect(gh.seen).toHaveLength(0);
    });
  }
});

describe("the token cache", () => {
  test("serves the cached token until 5 minutes before expires_at, then mints anew", async () => {
    const { gh, app } = setup();
    expect(await app.token(READ)).toBe("ghs_token1");
    clock += 54 * 60 * 1000;
    expect(await app.token(READ)).toBe("ghs_token1");
    clock += 60 * 1000; // expires_at - 5 min
    expect(await app.token(READ)).toBe("ghs_token2");
    // The installation id was cached: only one lookup across both exchanges.
    expect(gh.seen.filter((s) => s.url.endsWith("/installation"))).toHaveLength(1);
  });

  test("permission key order and owner/repo case don't split the cache; different scopes do", async () => {
    const { gh, app } = setup();
    const a = await app.token({ owner: "acme", repo: "widgets", permissions: { contents: "read", issues: "write" } });
    const b = await app.token({ owner: "ACME", repo: "Widgets", permissions: { issues: "write", contents: "read" } });
    expect(b).toBe(a);
    const c = await app.token({ owner: "acme", repo: "widgets", permissions: { contents: "write", issues: "write" } });
    expect(c).not.toBe(a);
    expect(gh.minted()).toBe(2);
  });

  test("undefined permission entries are dropped (not sent, not part of the cache key)", async () => {
    const { gh, app } = setup();
    const a = await app.token({ ...READ, permissions: { contents: "read", issues: undefined } });
    expect(gh.seen[1]!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
    expect(await app.token(READ)).toBe(a);
  });

  test("invalidate(req) normalizes like token(): the same request with undefined entries drops the cached token", async () => {
    const { gh, app } = setup();
    const req = { ...READ, permissions: { contents: "read" as const, issues: undefined } };
    await app.token(req);
    app.invalidate(req);
    expect(await app.token(req)).toBe("ghs_token2");
    expect(gh.minted()).toBe(2);
  });

  test("invalidate() with a request token() would reject is a no-op, not a throw", async () => {
    const { gh, app } = setup();
    await app.token(READ);
    expect(() => app.invalidate({ owner: "acme", repo: "..", permissions: {} })).not.toThrow();
    expect(() => app.invalidate({ owner: "acme" } as never)).not.toThrow();
    expect(await app.token(READ)).toBe("ghs_token1");
    expect(gh.minted()).toBe(1);
  });

  test("the admin level (repository_projects, organization_projects, …) passes through", async () => {
    const { gh, app } = setup();
    await app.token({ owner: "acme", repo: "widgets", permissions: { repository_projects: "admin" } });
    expect(gh.seen[1]!.body).toEqual({ repositories: ["widgets"], permissions: { repository_projects: "admin" } });
  });

  test("a cached installation id expires after an hour, so per-tenant entries don't accumulate", async () => {
    const { gh, app } = setup();
    const lookups = () => gh.seen.filter((s) => s.url.endsWith("/installation")).length;
    await app.token(READ);
    clock += 59 * 60 * 1000;
    await app.token({ ...READ, permissions: { issues: "read" } });
    expect(lookups()).toBe(1);
    clock += 60 * 1000; // an hour after the lookup
    await app.token({ ...READ, permissions: { pull_requests: "read" } });
    expect(lookups()).toBe(2);
  });

  test("invalidate(req) also forgets that repo's installation id; invalidate() forgets all", async () => {
    const { gh, app } = setup();
    const lookups = () => gh.seen.filter((s) => s.url.endsWith("/installation")).length;
    await app.token(READ);
    app.invalidate(READ);
    await app.token(READ);
    expect(lookups()).toBe(2);
    app.invalidate();
    await app.token({ ...READ, permissions: { issues: "read" } });
    expect(lookups()).toBe(3);
  });

  test("mutating the request after token() can't widen the exchanged or cached scope", async () => {
    const { gh, app } = setup();
    const req = { owner: "acme", repo: "widgets", permissions: { contents: "read" } as Record<string, "read" | "write"> };
    const pending = app.token(req);
    req.permissions.contents = "write"; // mutated before the exchange runs (it awaits the JWT first)
    req.repo = "other";
    await pending;
    expect(gh.seen[1]!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
    // And the cached entry is the read token under the read key.
    expect(await app.token(READ)).toBe("ghs_token1");
    expect(gh.minted()).toBe(1);
  });

  test("concurrent calls for one scope share a single exchange", async () => {
    const { gh, app } = setup();
    const all = await Promise.all(Array.from({ length: 10 }, () => app.token(READ)));
    expect(new Set(all)).toEqual(new Set(["ghs_token1"]));
    expect(gh.minted()).toBe(1);
  });

  test("a failed exchange is not cached — the next call retries", async () => {
    const { gh, app } = setup();
    gh.overrides.set("/app/installations/42/access_tokens", () => new Response("", { status: 503 }));
    await expect(app.token(READ)).rejects.toThrow(GitHubAppError);
    gh.overrides.clear();
    expect(await app.token(READ)).toBe("ghs_token1");
  });

  test("a token already inside the refresh margin is returned but not cached", async () => {
    const { gh, app } = setup({}, { expiresInMs: 4 * 60 * 1000 });
    await app.token(READ);
    await app.token(READ);
    expect(gh.minted()).toBe(2);
  });

  test("invalidate(req) drops one scope; invalidate() drops all", async () => {
    const { gh, app } = setup();
    const ISSUES = { ...READ, permissions: { issues: "read" as const } };
    await app.token(READ);
    await app.token(ISSUES);
    app.invalidate(READ);
    expect(await app.token(READ)).toBe("ghs_token3");
    expect(await app.token(ISSUES)).toBe("ghs_token2");
    app.invalidate();
    await app.token(READ);
    await app.token(ISSUES);
    expect(gh.minted()).toBe(5);
  });
});

describe("as a connection auth", () => {
  let preexisting = new Map(ACTION_REGISTRY);
  beforeEach(() => {
    preexisting = new Map(ACTION_REGISTRY);
    ACTION_REGISTRY.clear();
  });
  afterEach(() => {
    ACTION_REGISTRY.clear();
    for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
  });

  test("auth(req) resolves to exactly { token }", async () => {
    const { app } = setup();
    expect(await app.auth(READ)()).toEqual({ token: "ghs_token1" });
  });

  test("auth(fn) scopes the token by the call's identity; the token reaches the remote, never the tool input or result", async () => {
    const { gh, app } = setup();
    gh.installed.set("tenant-a/repo", 1);
    gh.installed.set("tenant-b/repo", 2);
    const identities: unknown[] = [];
    const auth = app.auth((ctx) => {
      identities.push(ctx?.user?.id);
      return { owner: ctx?.user?.id ?? "tenant-a", repo: "repo", permissions: { issues: "write" } };
    });

    const origFetch = globalThis.fetch;
    const remoteAuth: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      remoteAuth.push(new Headers(init!.headers).get("authorization")!);
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "comment", inputSchema: { type: "object", properties: {} } }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } });
    }) as typeof fetch;
    try {
      const { actions } = await connectAll([defineMcpConnection({ name: "github", url: "https://mcp.example.com/", auth })]);
      const tool = actions.find((a) => a.id === "github__comment")!;
      const input = { body: "hi" };
      const result = await tool.run(input as never, { user: { id: "tenant-b" } } as never);
      expect(result).toEqual({ ok: true });
      expect(JSON.stringify(input) + JSON.stringify(result)).not.toContain("ghs_");
    } finally {
      globalThis.fetch = origFetch;
    }
    // Discovery ran without identity (tenant-a fallback); the call as tenant-b.
    expect(identities).toEqual([undefined, undefined, "tenant-b"]);
    expect(remoteAuth).toEqual(["Bearer ghs_token1", "Bearer ghs_token1", "Bearer ghs_token2"]);
    expect(gh.seen.find((s) => s.url.endsWith("/installations/2/access_tokens"))).toBeDefined();
  });

  test("the documented tenant pattern: requiresPrincipal stops an anonymous call before auth mints anything", async () => {
    const { gh, app } = setup();
    gh.installed.set("acme-t1/widgets", 5);
    const auth = app.auth((ctx) =>
      ctx?.user
        ? { owner: `acme-${ctx.user.id}`, repo: "widgets", permissions: { issues: "write" } }
        : { owner: "acme", repo: "widgets", permissions: { metadata: "read" } },
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "comment", inputSchema: { type: "object", properties: {} } }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } });
    }) as typeof fetch;
    try {
      await connectAll([defineMcpConnection({ name: "github", url: "https://mcp.example.com/", auth, requiresPrincipal: true })]);
      const exchanges = () => gh.seen.filter((s) => s.url.endsWith("/access_tokens")).map((s) => s.body);
      // Discovery minted only the read-only credential.
      expect(exchanges()).toEqual([{ repositories: ["widgets"], permissions: { metadata: "read" } }]);
      await expect(invokeAction("github__comment", {})).rejects.toThrow(/requires an authenticated principal/);
      expect(exchanges()).toHaveLength(1); // nothing minted for the anonymous call
      await invokeAction("github__comment", {}, { user: { id: "t1" } });
      expect(exchanges().at(-1)).toEqual({ repositories: ["widgets"], permissions: { issues: "write" } });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

test("src/github.ts stays web-standard (no node:* imports) so it runs on the edge", () => {
  const src = readFileSync(new URL("../src/github.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/from\s+["']node:|require\(|from\s+["'](crypto|buffer|fs)["']/);
});
