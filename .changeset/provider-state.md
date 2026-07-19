---
"@junejs/core": patch
---

`ToolCall.providerState` (#92) — opaque round-trip state for model adapters. Some providers attach state to tool calls that must be replayed verbatim (Gemini 3+ rejects replays omitting its per-call `thoughtSignature`); adapters previously smuggled it inside the call id, leaking it into ledgers keyed by callId and breaking on id normalization. The field is written by the adapter, stored on the assistant message with the call, and handed back untouched on replay — the engine never reads it and it is never part of identity (step keys and dispatch use `id` alone).
