---
"@junejs/server": minor
---

Connection auth helpers — turn an authenticated principal into a per-call bearer
token for an outbound connection (provider/mcp/openapi), so the token is resolved
server-side and never reaches the model.

- `linkedAccountAuth({ providerId, store })`: the generic, auth-library-agnostic
  core. Inject a `store` (an `AccountTokenStore` — where the caller's OAuth
  account tokens live) and it returns a `ConnectionAuth` — `auth(ctx)` that mints
  the CALLER's token. FAIL CLOSED: a missing principal or an unlinked account
  throws (together with the connection's `requiresPrincipal`, the capability is
  unreachable without a real credential). Reusable across every connection kind,
  not just Google Drive.
- `betterAuthAccessToken(auth, { providerId })` / `betterAuthAccountTokenStore(auth)`:
  the blessed Better Auth convenience. STRUCTURAL (`BetterAuthLike`), so wiring it
  adds NO `better-auth` dependency and stays fully overridable — a Service Account
  or custom-store user pays nothing (pure opt-in exports, tree-shaken away).

Lives in the host layer by design (the auth integration is not `@junejs/core`'s
job); pure logic, no `node:*`. Example:

```ts
googleDriveConnection({
  requiresPrincipal: true,
  auth: betterAuthAccessToken(auth, { providerId: "google" }),
});
```
