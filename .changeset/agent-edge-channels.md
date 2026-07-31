---
"@junejs/core": patch
"@junejs/server": patch
---

Edge channel webhooks + lazy DO connections — the last two #139 items.

**Channel webhooks route through the built worker.** `WorkerManifest.agentChannels` carries the compiled agent module's channels (Channel or `(env) => Channel` factories), and `createWorker` mounts them via `durableChannelSurface` next to the chat endpoint — gated by `agent.runtime.channels` (default on). The missing piece was the execution context: webhook channels ACK fast and finish their work on `waitUntil`, so `createWorker.fetch` (and `withAssets`) now accept workerd's `ctx` as an optional third parameter (`WorkerExecutionContext`) and thread `waitUntil` into the per-request channel surface. Channel construction per request is the documented pattern — `resolveChannel` is a call, and the services bag memoizes per (env, agentName). The generated entry assembles `__agentDef` before `createWorker` and passes `agentChannels: __agentDef.channels`, so a June-native app's webhooks now mount with zero glue, matching what the hand-written wrangler-first examples always did.

**Connections wire lazily in the DO.** `DoAgentDef.connections` accepts the compiled connection definitions (external MCP/OpenAPI servers); `connectAll` is network I/O a DO constructor can't await, so they resolve at the first turn — alongside the resources provider, behind one `ready()` gate hoisted before every synchronous scope-and-subscribe section — and their `<connection>__<tool>` tools merge into the agent's tool set before any session is constructed. A failed connection is reported and skipped (never throws), matching native assembly. `assembleDurable` now passes `connections` through, so the generated DO (and any hand-written shell spreading it) gets outbound tools with no extra wiring — the native/edge capability gap for connections is closed.
