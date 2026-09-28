// Capture REAL GitHub responses for the fake in github.test.ts, scrubbed of
// credentials. The unit suite stays offline; these fixtures keep its fake honest
// about what GitHub actually answers (shapes, the mandatory metadata grant, the
// token format, error bodies). Refresh them when github-live.test.ts starts
// failing, or when the fake is suspected of drifting.
//
// Uses the same throwaway App + repo as the live suite:
//
//   GITHUB_LIVE_APP_ID=… GITHUB_LIVE_PRIVATE_KEY="$(cat app.pem)" \
//   GITHUB_LIVE_REPO=owner/repo bun packages/core/test/fixtures/github-app/capture.ts
//
// The App must have Contents: read (and not Administration: write) on that repo.
// No token, JWT or key is ever written: the installation token is replaced by a
// same-length placeholder that keeps its `ghs_` prefix.

import { createPrivateKey, createSign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { CREDENTIAL } from "./credential";

const appId = process.env.GITHUB_LIVE_APP_ID;
const privateKey = process.env.GITHUB_LIVE_PRIVATE_KEY;
const [owner, repo] = (process.env.GITHUB_LIVE_REPO ?? "").split("/");
if (!appId || !privateKey || !owner || !repo) {
  console.error("Set GITHUB_LIVE_APP_ID, GITHUB_LIVE_PRIVATE_KEY and GITHUB_LIVE_REPO (see the header).");
  process.exit(1);
}

const API = "https://api.github.com";
const now = Math.floor(Date.now() / 1000);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: Number(appId) })}`;
const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(privateKey)).toString("base64url")}`;
const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "june-github-fixture-capture",
  "x-github-api-version": "2022-11-28",
};

type Fixture = { request: string; status: number; body: unknown };

// Each capture states the status it expects: a surprise (e.g. the App was given
// administration:write, so the "denied" exchange succeeds and returns a live
// token) aborts BEFORE anything is written.
async function capture(
  name: string,
  expected: number,
  method: string,
  path: string,
  opts: { body?: unknown; auth?: string } = {},
): Promise<Fixture> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...headers, authorization: `Bearer ${opts.auth ?? jwt}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (res.status !== expected) throw new Error(`${name}: expected ${expected}, got ${res.status} — nothing written; check the App's permissions/installation.`);
  const fixture: Fixture = { request: `${method} ${path}${opts.body ? ` ${JSON.stringify(opts.body)}` : ""}`, status: res.status, body: await res.json() };
  return save(name, fixture);
}

function save(name: string, fixture: Fixture): Fixture {
  const text = JSON.stringify(fixture, null, 2) + "\n";
  // Belt and braces: nothing that looks like a live credential may be written.
  if (text.includes(jwt) || CREDENTIAL.test(text)) throw new Error(`${name}: refusing to write a credential — nothing written`);
  writeFileSync(new URL(`./${name}.json`, import.meta.url), text);
  console.log(`${name}.json  ${fixture.status}  ${fixture.request}`);
  return fixture;
}

const installation = await capture("installation", 200, "GET", `/repos/${owner}/${repo}/installation`);
const id = (installation.body as { id: number }).id;

// The token exchange: scrub the token BEFORE anything is written.
const res = await fetch(`${API}/app/installations/${id}/access_tokens`, {
  method: "POST",
  headers: { ...headers, authorization: `Bearer ${jwt}`, "content-type": "application/json" },
  body: JSON.stringify({ repositories: [repo], permissions: { contents: "read" } }),
});
if (res.status !== 201) throw new Error(`access-token: expected 201, got ${res.status} — nothing written.`);
const tokenBody = (await res.json()) as { token: string };
const placeholder = `ghs_${"x".repeat(tokenBody.token.length - 4)}`;
if (!tokenBody.token.startsWith("ghs_")) throw new Error("unexpected token prefix");
save("access-token", {
  request: `POST /app/installations/{id}/access_tokens ${JSON.stringify({ repositories: [repo], permissions: { contents: "read" } })}`,
  status: res.status,
  body: { ...tokenBody, token: placeholder },
});

await capture("access-token-permission-denied", 422, "POST", `/app/installations/${id}/access_tokens`, {
  body: { repositories: [repo], permissions: { administration: "write" } },
});
await capture("installation-not-found", 404, "GET", "/repos/octocat/Hello-World/installation");
await capture("bad-jwt", 401, "GET", `/repos/${owner}/${repo}/installation`, { auth: `${unsigned}.invalid-signature` });
