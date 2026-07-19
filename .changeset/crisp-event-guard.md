---
"@junejs/core": patch
---

`isCrispEvent` now also requires `data` to be a non-null object (#91) — the webhook envelope is parsed from untrusted JSON, and a malformed delivery (null/missing/scalar `data`) used to pass the guard and throw on the first `payload.data.x` access downstream; it now fails the narrow (and `normalizeCrispEvent` drops it) instead. Also exports `CrispWebhookEnvelope` — the all-optional envelope shape (`website_id` / `event` / `data` / `timestamp`) apps kept re-declaring; the guard's narrowed type now includes it, so envelope fields stay readable after the narrow.
