---
"@junejs/og": patch
---

`ImageResponse` now answers with one `Content-Type` and one `Cache-Control` on every backend, whatever casing the caller's header names use.

On Workers, `headers: OG_HEADERS` sent `Content-Type: image/png, image/png` and a `Cache-Control` that joined workers-og's year-long immutable default with the caller's `max-age=86400`: workers-og stores its defaults under title-case keys and then spreads the caller's headers, so the lowercase keys became second entries and `Headers` appended both. The Workers backend now builds the response itself and lets workers-og render the body only. With `debug: true`, Workers no longer switches `Cache-Control` to `no-cache, no-store`; pass `headers: { "cache-control": "no-store" }` for that.

On Node and edge the same thing happened the other way round: a title-case `Cache-Control` or `Content-Type` from the caller joined the lowercase defaults instead of replacing them. All three backends now merge headers case-insensitively and set `content-type: image/png` last.
