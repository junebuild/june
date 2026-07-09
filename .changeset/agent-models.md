---
"@junejs/core": minor
---

Add `@junejs/core/agent-models` — Model-seam provider adapters.

`anthropic({ model, apiKey?, system?, maxTokens?, thinking? })` turns the
official `@anthropic-ai/sdk` into the agent runtime's provider-agnostic `Model`
(streams via `.finalMessage()`; maps the durable transcript ↔ Anthropic Messages,
folding parallel tool results). The SDK is an **optional peer**, lazy-imported via
a non-literal specifier, so `@junejs/core` stays installable and typecheckable
without it and the adapter runs on native *and* edge (pass `apiKey` on the edge).
Thinking is off by default until the transcript persists thinking blocks.
