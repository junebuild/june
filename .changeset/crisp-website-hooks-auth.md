---
"@junejs/core": patch
---

`crispChannel` supports Crisp **website hooks** (dashboard-configured, unsigned) alongside plugin hooks:

- New `auth` option, a discriminated union naming which webhook contract you're on: `{ type: "signature", secret }` (plugin hooks — HMAC + replay guard, unchanged) or `{ type: "urlKey", key, param? }` (website hooks — Crisp's documented shared-key-in-URL pattern, compared in constant time; default param `key`).
- `signingSecret` stays as the plugin-hook shorthand (`≡ auth: { type: "signature", secret }`). Passing both throws at construction, as does passing neither — a channel that silently 401s every delivery is much harder to diagnose.
- `verifyCrispUrlKey(expectedKey, url, param?)` is exported next to `verifyCrispSignature` (composability floor). An empty configured key always fails — same closed-by-default posture as an empty signing secret.
