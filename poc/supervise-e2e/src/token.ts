// A June-issued bearer token, the minimal version (#297): a JWT (RFC 7519) signed HS256 with an
// app secret, via WebCrypto so the same code runs on Bun, Node and workerd. Claims: sub (the
// principal id), scope (space-separated, the OAuth convention of RFC 8693 §4.2), iat, exp, jti,
// aud. Verification pins the algorithm (never trusts the header's `alg`), the audience and expiry.

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const b64urlJson = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

export const AUDIENCE = "june:inbox";
export type Claims = { sub: string; scope: string; iat: number; exp: number; jti: string; aud: string };
export type TokenPrincipal = { id: string; scopes: string[]; tokenId: string; via: "june-token" };

async function key(secret: string): Promise<CryptoKey> {
  if (enc.encode(secret).length < 32) throw new Error("token secret must be at least 32 bytes");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueToken(secret: string, o: { sub: string; scopes: string[]; ttlSeconds: number; now?: number }): Promise<string> {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const claims: Claims = { sub: o.sub, scope: o.scopes.join(" "), iat, exp: iat + o.ttlSeconds, jti: crypto.randomUUID(), aud: AUDIENCE };
  const head = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(head)));
  return `${head}.${b64url(sig)}`;
}

export type VerifyResult = { ok: true; principal: TokenPrincipal } | { ok: false; reason: string };

export async function verifyToken(secret: string, token: string, now = Date.now()): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; typ?: string };
  let claims: Partial<Claims>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: `alg ${header.alg} not accepted` };
  const valid = await crypto.subtle.verify("HMAC", await key(secret), Buffer.from(s, "base64url"), enc.encode(`${h}.${p}`));
  if (!valid) return { ok: false, reason: "bad signature" };
  if (claims.aud !== AUDIENCE) return { ok: false, reason: "wrong audience" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return { ok: false, reason: "expired" };
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "no subject" };
  return { ok: true, principal: { id: claims.sub, scopes: (claims.scope ?? "").split(" ").filter(Boolean), tokenId: claims.jti ?? "", via: "june-token" } };
}
