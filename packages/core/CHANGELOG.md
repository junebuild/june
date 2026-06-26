# @junejs/core

## 0.0.47

### Patch Changes

- [#14](https://github.com/junebuild/june/pull/14) [`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8) Thanks [@linyiru](https://github.com/linyiru)! - fix(client-router): percent-encode the soft-nav title header (non-ASCII titles no longer 500)

  The `fragment` projection put the page title verbatim into the `x-june-title`
  header. HTTP header values are ByteStrings (Latin-1, ≤0xFF), so a non-ASCII
  title — CJK, accents, emoji — threw `TypeError: Cannot convert argument to a
ByteString` at `headers.set`, crashing the whole fragment render with a 500. The
  client router then hit its hard-navigation fallback, so every soft nav to a
  non-ASCII-titled page became a full document reload — the white flash
  `clientRouter` exists to remove (the failure on Node/undici runtimes like
  Vercel's serverless functions; only ASCII-titled pages soft-navigated).

  The server now `encodeURIComponent`s the title before `headers.set`, and the
  three client consumers (morph router, flight router, dev live-reload) decode it
  back with `decodeURIComponent` before assigning `document.title`. ASCII titles
  are unchanged on the wire (`encodeURIComponent("Home") === "Home"`).
