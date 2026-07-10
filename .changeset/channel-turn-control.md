---
"@junejs/core": patch
"@junejs/server": patch
---

Channel turn-control + source-aware prompts, so a shared agent needs far less custom channel code:

- **`respondTo`** (slackChannel): per-KIND control over which subscribed events drive a turn+reply; the rest reach only `onEvent`. e.g. `events:["app_mention","reaction_added"], respondTo:["app_mention"]` runs a turn for a mention but treats a reaction as a deterministic observe (no LLM).
- **`channelInstructions`** (defineAgent / DoAgentDef): per-source system overlays. When a turn's `InboundEvent.source` matches a key, that text is appended to the system prompt — a shared agent branches on the real, unforgeable source instead of a userText marker. `withSystem` now appends a per-turn overlay to the base instead of dropping it.
- **AgentDurableObject `channels` + `env`**: builds a mounted channel's capability tools inside the DO (a tool's run closure can't cross the worker→DO RPC) — the edge equivalent of `defineAgent` merging `channel.tools()` on native.
- **Exported primitives**: `verifySlackSignature`, `verifyCrispSignature`, `normalizeSlackEvent`, `tryParseJson`, `timestampFresh` — a hand-rolled channel reuses the crypto/normalization instead of re-implementing it.
