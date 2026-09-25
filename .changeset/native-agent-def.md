---
"@junejs/server": patch
---

One definition for the engine and the channels on the native host (#173). An app wiring `mountAgent` by hand declared tools and instructions twice — on `defineAgent(...)` for the channels and on `createNativeRuntime({ [name]: { model, tools, instructions } })` for the engine — and nothing tied the two together. New `toAgentDef(agent, model)` derives the runtime entry from the `AgentDefinition`: its tools (channel capability tools and `read_skill` included), the system prompt with the skill index (`buildSystemPrompt`), and the per-surface policies. `mountAgent` now warns once when a runtime entry's tools differ from the definition's, naming what is missing on each side.

Fixed along the way: the built-in native agent mount (`app.ts`) passed the system prompt but dropped `channelInstructions`, so per-surface overlays and `denyTools` policies (#149) never applied on the native host — it now uses `toAgentDef`. `MemoryRuntime` ignored `instructions` and `channelInstructions` entirely, so `backend: "memory"` ran without a system prompt; it now applies both exactly as `NativeRuntime` does. `AgentDef.channelInstructions` accepts `ChannelPolicy` values, matching what the engine takes.
