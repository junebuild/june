---
"@junejs/core": patch
"@junejs/server": patch
---

Delivered turns — a reply-bearing turn's rendering now survives the edge waitUntil ceiling.

A streamed inbound reply (Slack `respondTo` + `stream: true`) used to be rendered by the
WORKER consuming the DO's SSE turn stream inside `ctx.waitUntil` — so a turn running past
the post-ACK grace (~30s) was cancelled mid-flight: no `turn.failed`, no `onTurnError`, no
reply, nothing in the thread (production failure mode: a multi-round Q&A turn ended in
silence). `runDetached` (#77) already rescued *reply-dropping* shadow turns; this adds the
reply-bearing sibling:

- **`ctx.runDelivered`** (ChannelContext, provided by `durableChannelSurface`): start the
  turn and have the TURN'S HOST render the reply — 202 on acceptance, nothing held open.
- **`POST /turn?deliver=1`** (AgentDurableObject): renders the turn's event stream through
  the source channel's own `deliver()` (the P4 §9 renderer) from INSIDE the DO, under the
  DO's own lifetime. Requires the channel wired via `DoAgentDef.channels`; refuses with a
  **501 before starting the turn** otherwise.
- **`DeliverUnsupportedError`** (agent-config): the surface maps that pre-start 501 to this
  typed rejection — the one error a channel may answer with a consumer-side rendering
  fallback (`ctx.runStream`) without double-running the turn.
- **slackChannel** now prefers `ctx.runDelivered` on its streaming `respondTo` path and
  falls back to worker-side rendering only on `DeliverUnsupportedError`.

Adopting on the durable edge: pass the same channel factories to the DO —
`new AgentDurableObject(ctx, { …, channels: [slackChannel], env })` — or the channel falls
back to the old (ceiling-bounded) worker-side rendering.
