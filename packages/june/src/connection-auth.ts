// connection-auth.ts — turn an authenticated principal into a per-call bearer
// token for an outbound connection (provider / mcp / openapi).
//
// A connection's `auth(ctx)` seam resolves the credential PER CALL, server-side,
// so the token never reaches the model. The common, fiddly case is "use the
// CALLER's linked OAuth account" — look up the principal's stored token for a
// provider, fail closed when it isn't there. This module standardizes that:
//
//   • linkedAccountAuth — the generic core. You inject a `store` (where account
//     tokens live); it handles the ctx→userId extraction and the fail-closed
//     contract. Reusable across connections whose `auth` is resolved PER CALL
//     with the caller's identity — i.e. PROVIDER connections (Google Drive), and
//     MCP/OpenAPI remotes that don't authenticate discovery.
//
//     ⚠️ Not for MCP/OpenAPI connections that DO require auth for discovery:
//     connectMcp/connectOpenapi call `auth(undefined)` at initialize/tools-list/
//     schema-fetch time (before any turn), and this helper fails closed on a
//     missing principal — so discovery would report zero tools. Those need a
//     discovery-scoped credential, not a per-caller one.
//   • betterAuthAccountTokenStore / betterAuthAccessToken — the blessed Better
//     Auth convenience. Kept STRUCTURAL (no `better-auth` import), so wiring it
//     adds no dependency and stays fully overridable — swap the store for a
//     custom table, a secrets vault, or a Service Account minter.
//
// Pure logic (no node:*), tied only to the identity types in @junejs/core — the
// auth INTEGRATION lives in the host layer by design (see docs/auth-integration.md),
// which is why it is here and not in the pure contract layer.

import type { ActionContext } from "@junejs/core/context";

// Where a principal's OAuth account tokens live. Given the caller's principal id
// and a provider, return a FRESH access token (the store refreshes if needed),
// or null when the user hasn't linked that provider. Better Auth's account table
// is the blessed implementation; anything satisfying this shape works.
export type AccountTokenStore = (args: {
  userId: string;
  providerId: string;
}) => Promise<{ accessToken: string } | null> | { accessToken: string } | null;

export type LinkedAccountAuthOptions = {
  // Which linked provider to mint a token for, e.g. "google".
  providerId: string;
  // The token source (injected — this is the overridable seam).
  store: AccountTokenStore;
};

// The connection `auth(ctx)` shape: resolve a bearer token from the call's
// identity, server-side. (Structurally identical to connections' internal Auth
// and to GoogleDriveAuth.)
export type ConnectionAuth = (ctx?: ActionContext) => Promise<{ token: string }>;

// Build an `auth(ctx)` for ANY June connection that mints the CALLER's
// linked-account token. FAIL CLOSED: a missing principal or an unlinked account
// throws — so an authenticated-but-unlinked user gets a clear error, and
// (together with the connection's `requiresPrincipal`, which hides the tools from
// anonymous turns) the capability is never reachable without a real credential.
export function linkedAccountAuth(opts: LinkedAccountAuthOptions): ConnectionAuth {
  return async (ctx?: ActionContext): Promise<{ token: string }> => {
    const userId = ctx?.user?.id;
    if (!userId) {
      throw new Error(`connection auth (${opts.providerId}): no authenticated principal — set requiresPrincipal and resolve identity on the surface`);
    }
    const record = await opts.store({ userId, providerId: opts.providerId });
    if (!record?.accessToken) {
      throw new Error(`connection auth (${opts.providerId}): user "${userId}" has no linked "${opts.providerId}" account`);
    }
    return { token: record.accessToken };
  };
}

// The minimal Better-Auth surface this reads — STRUCTURAL, so importing the
// helper doesn't drag in `better-auth`. A real Better Auth server instance
// satisfies it: `auth.api.getAccessToken` takes an ENDPOINT INPUT shaped as
// `{ body: { providerId, userId, accountId? }, headers? }` and refreshes the
// stored token when expired. The reply key differs across versions (accessToken
// vs token), so both are accepted.
export type BetterAuthLike = {
  api: {
    getAccessToken: (input: {
      body: { providerId: string; userId?: string; accountId?: string };
      headers?: HeadersInit;
    }) => Promise<{ accessToken?: string; token?: string } | null | undefined>;
  };
};

// Adapt a Better-Auth-shaped instance into an AccountTokenStore. Passes `userId`
// in the endpoint `body` (server-side lookup — no request session needed).
export function betterAuthAccountTokenStore(auth: BetterAuthLike): AccountTokenStore {
  return async ({ userId, providerId }) => {
    const res = await auth.api.getAccessToken({ body: { providerId, userId } });
    const accessToken = res?.accessToken ?? res?.token;
    return accessToken ? { accessToken } : null;
  };
}

// Sugar: a fail-closed `auth(ctx)` backed by Better Auth in one call.
//
//   googleDriveConnection({ requiresPrincipal: true, auth: betterAuthAccessToken(auth, { providerId: "google" }) })
export function betterAuthAccessToken(auth: BetterAuthLike, opts: { providerId: string }): ConnectionAuth {
  return linkedAccountAuth({ providerId: opts.providerId, store: betterAuthAccountTokenStore(auth) });
}
