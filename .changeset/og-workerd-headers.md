---
"@junejs/og": patch
---

On Workers, `ImageResponse` with `headers: OG_HEADERS` no longer sends two `Content-Type` values or a `Cache-Control` that joins workers-og's year-long immutable default with the caller's `max-age=86400`. workers-og stores those defaults under title-case keys and then spreads the caller's headers, so lowercase `OG_HEADERS` became a second entry and `Headers` appended both. The Workers backend now builds the response itself, merges headers with `Headers.set`, and sets `content-type: image/png` last — the same envelope node and edge already return.
