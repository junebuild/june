---
"@junejs/core": minor
---

GitHub App credentials: short-lived, per-repo installation tokens (`@junejs/core/github`).

- `githubApp({ appId, privateKey })` mints an installation token scoped to ONE
  repository and the `permissions` a call names:
  `await gh.token({ owner, repo, permissions: { contents: "read" } })`. GitHub
  makes read-only `metadata` mandatory for Apps with repository access, so the
  token may also carry `metadata: read` when the call doesn't name it. It signs
  the RS256 App JWT with WebCrypto (no `node:*`, so it runs on the edge), looks
  up the installation, and narrows the exchange to `repositories: [repo]`.
- `gh.auth(req | (ctx) => req)` plugs into any connection's `auth`, so the
  token is resolved per call, server-side, and never reaches the model. Use the
  function form to scope the token by the caller's identity.
- Tokens are cached per `(owner, repo, permissions)` until five minutes before
  they expire. Concurrent calls for one scope share one exchange, and
  `gh.invalidate(req?)` drops cached tokens.
- The private key may be PKCS#1 (what GitHub issues) or PKCS#8. Literal `\n`
  escapes, CRLF line endings, surrounding quotes and a base64-wrapped PEM are
  all accepted.
- `permissions` is required: without it, GitHub grants every permission the
  installation has. If GitHub grants less than was asked, the call fails closed.
- Failures are `GitHubAppError`s with a `code`: `not_installed`,
  `permission_denied`, `unauthorized`, `rate_limited` (with `retryAfter` when
  GitHub gives one), `network` (with the original error as `cause`),
  `invalid_key`, `invalid_request` or `http`. A success response that lacks a
  token or a valid `expires_at` fails closed as `http`.
- `apiBaseUrl` targets GitHub Enterprise Server.
