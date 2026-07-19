---
"@junejs/server": patch
---

The external session key now reaches the turn scope on the Durable Object
target (#75): `durableFetch` stamps the key on an `x-june-session` header
(exported as `SESSION_HEADER`), and `AgentDurableObject` resolves its
session lazily from it — first keyed request wins, the key is persisted in
the DO's storage so it survives hibernation/eviction, and key-less paths
fall back to the persisted key. Tools finally see the real conversation as
`ctx.sessionId` instead of the literal `"self"`. A key that contradicts the
object's identity is refused loudly (409) rather than silently corrupting
per-session data. Backward compatible: with no key anywhere, the session id
stays `"self"`. The direct API gains `turn({ session })` for custom shells.
