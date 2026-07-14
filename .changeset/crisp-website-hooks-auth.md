---
"@junejs/core": patch
---

`crispChannel` supports Crisp **website hooks** (dashboard-configured, unsigned) alongside plugin hooks:

- New `auth` option, a discriminated union naming which webhook contract you're on: `{ type: "signature", secret }` (plugin hooks — HMAC + replay guard, unchanged) or `{ type: "urlKey", key, param? }` (website hooks — Crisp's documented shared-key-in-URL pattern, compared in constant time; default param `key`).
- `signingSecret` stays as the plugin-hook shorthand (`≡ auth: { type: "signature", secret }`). Exactly one of `auth`/`signingSecret` is enforced at the type level (both/neither is a compile error), with construction-time throws as the runtime backstop — a channel that silently 401s every delivery is much harder to diagnose.
- In `urlKey` mode an invalid key is rejected before the request body is read; `signature` mode reads first because the MAC covers the raw body.
- `verifyCrispUrlKey(expectedKey, url, param?)` is exported next to `verifyCrispSignature` (composability floor). An empty configured key always fails — same closed-by-default posture as an empty signing secret — and unparseable URLs fail closed (never throw); path-relative URLs are accepted.
