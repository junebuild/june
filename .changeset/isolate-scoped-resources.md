---
"@junejs/db": minor
"@junejs/server": patch
---

Isolate-scoped state: `isolateLocal`, and the services bag is no longer rebuilt per request.

June resolves ChannelFactories and the `services` provider **per request** — a
Worker has no `env` at module top-level, so the host must call them inside an
invocation. The consequence was a footgun: anything they construct, including a
cache, is rebuilt per request, so an app that "added a 5-minute cache" silently
never got a hit. The fix is in two halves.

- **`isolateLocal(key, make)`** (`@junejs/db`) — the sibling of `requestLocal`,
  for state that must OUTLIVE a request: a connection pool, a token cache, a
  compiled index. Keyed off `globalThis` (the same trick `ACTION_REGISTRY`
  uses), so duplicate module instances from workspace symlinks share one value
  instead of splitting the cache in two. Values are never evicted — anything
  with a bound must bound itself.
- **`durableChannelSurface({ services })` is memoized per `env`** — resolved once
  per isolate rather than once per surface construction, so clients and caches in
  the bag survive across webhooks. The contract is unchanged (the provider must
  be a function of `env` alone); a fresh `env` object still gets a fresh bag, and
  a non-object `env` skips memoization.
