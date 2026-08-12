// connection-auth.test.ts — the helpers that turn an authenticated principal into
// a per-call bearer token for an outbound connection. Covers the generic
// fail-closed core (linkedAccountAuth), the structural Better Auth adapter, and
// that the result is drop-in usable as a connection's `auth(ctx)` — plus the
// Service Account path, which bypasses these helpers entirely (zero involvement).

import { describe, expect, test } from "bun:test";
import {
  linkedAccountAuth,
  betterAuthAccessToken,
  betterAuthAccountTokenStore,
  type AccountTokenStore,
  type BetterAuthLike,
} from "../src/connection-auth";

describe("linkedAccountAuth", () => {
  const store: AccountTokenStore = ({ userId, providerId }) =>
    userId === "acme" && providerId === "google" ? { accessToken: `tok-${userId}` } : null;

  test("mints the CALLER's token from the store", async () => {
    const auth = linkedAccountAuth({ providerId: "google", store });
    expect(await auth({ user: { id: "acme" } })).toEqual({ token: "tok-acme" });
  });

  test("passes the principal id and provider through to the store", async () => {
    const seen: unknown[] = [];
    const spy: AccountTokenStore = (args) => {
      seen.push(args);
      return { accessToken: "x" };
    };
    await linkedAccountAuth({ providerId: "notion", store: spy })({ user: { id: "u1" } });
    expect(seen).toEqual([{ userId: "u1", providerId: "notion" }]);
  });

  test("fails closed when there is no authenticated principal", async () => {
    const auth = linkedAccountAuth({ providerId: "google", store });
    await expect(auth(undefined)).rejects.toThrow(/no authenticated principal/);
    await expect(auth({})).rejects.toThrow(/no authenticated principal/);
  });

  test("fails closed when the user has not linked the provider", async () => {
    const auth = linkedAccountAuth({ providerId: "google", store });
    await expect(auth({ user: { id: "nobody" } })).rejects.toThrow(/no linked "google" account/);
  });

  test("an async store is awaited", async () => {
    const asyncStore: AccountTokenStore = async ({ userId }) => ({ accessToken: `async-${userId}` });
    const auth = linkedAccountAuth({ providerId: "google", store: asyncStore });
    expect(await auth({ user: { id: "z" } })).toEqual({ token: "async-z" });
  });
});

describe("betterAuthAccountTokenStore / betterAuthAccessToken (structural adapter)", () => {
  // A fake Better-Auth-shaped instance — no `better-auth` package involved. The
  // real server API takes `{ body: { providerId, userId } }`.
  const fakeAuth = (byUser: Record<string, string>, key: "accessToken" | "token" = "accessToken"): BetterAuthLike => ({
    api: {
      getAccessToken: async ({ body }) => (body.userId && byUser[body.userId] ? { [key]: byUser[body.userId] } : null),
    },
  });

  test("adapts getAccessToken into an AccountTokenStore", async () => {
    const store = betterAuthAccountTokenStore(fakeAuth({ acme: "ga-acme" }));
    expect(await store({ userId: "acme", providerId: "google" })).toEqual({ accessToken: "ga-acme" });
    expect(await store({ userId: "ghost", providerId: "google" })).toBeNull();
  });

  test("accepts the `token` reply key too (version drift)", async () => {
    const store = betterAuthAccountTokenStore(fakeAuth({ acme: "t-acme" }, "token"));
    expect(await store({ userId: "acme", providerId: "google" })).toEqual({ accessToken: "t-acme" });
  });

  test("calls getAccessToken with the endpoint body shape { body: { providerId, userId } }", async () => {
    const calls: unknown[] = [];
    const auth: BetterAuthLike = { api: { getAccessToken: async (input) => { calls.push(input); return { accessToken: "x" }; } } };
    await betterAuthAccountTokenStore(auth)({ userId: "u1", providerId: "google" });
    expect(calls).toEqual([{ body: { providerId: "google", userId: "u1" } }]);
  });

  test("betterAuthAccessToken is a fail-closed auth(ctx) in one call", async () => {
    const auth = betterAuthAccessToken(fakeAuth({ acme: "ga-acme" }), { providerId: "google" });
    expect(await auth({ user: { id: "acme" } })).toEqual({ token: "ga-acme" });
    await expect(auth({ user: { id: "unlinked" } })).rejects.toThrow(/no linked "google" account/);
    await expect(auth(undefined)).rejects.toThrow(/no authenticated principal/);
  });
});

describe("usable as a connection auth (shape contract)", () => {
  test("the produced auth matches a connection's auth(ctx) => { token } shape", async () => {
    // GoogleDriveAuth / connections' Auth is (ctx?) => Promise<{token}> | {token}.
    const auth = linkedAccountAuth({ providerId: "google", store: () => ({ accessToken: "ok" }) });
    const result = await auth({ user: { id: "acme" } });
    expect(result).toHaveProperty("token");
    expect(typeof result.token).toBe("string");
  });

  test("Service Account path needs none of these helpers (plain auth still works)", async () => {
    // A Service Account user just returns a token — documents that the helpers are
    // pure opt-in and impose nothing on that path.
    const saAuth = async () => ({ token: "sa-minted-token" });
    expect(await saAuth()).toEqual({ token: "sa-minted-token" });
  });
});
