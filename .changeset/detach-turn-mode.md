---
"@junejs/server": patch
"@junejs/core": patch
---

Fire-and-forget turn mode (#77): `POST /turn?detach=1` makes the Durable
Object respond 202 as soon as the turn is durably accepted and run it under
its OWN lifetime — a DO stays alive while it has pending work — instead of
bounding turn duration by however long the caller can hold a connection
(the edge worker's post-ACK waitUntil ceiling killed 24–38s shadow turns in
production). `ChannelContext` gains an optional `runDetached(message, opts)
→ { turnId }`, implemented by both `durableChannelSurface` (edge) and
`mountAgent` (native), and `AgentDurableObject` gains `start()` for custom
shells. Detached turns have no live consumer: failures surface via the
default turn-failure log / `onTurnError`. The awaited `/turn` SSE contract
is unchanged.
