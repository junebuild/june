---
"@junejs/core": minor
"@junejs/server": minor
---

Make an agent's instructions first-class on the def (no longer silently droppable).

Previously the system prompt was baked into the `model` at construction
(`anthropic({ system: buildSystemPrompt(agent) })`), and the runtime def was
`{ model, tools }` — so instructions were lost at that hand-off unless the caller
remembered to bake them in.

Now:
- `Model` gains an optional `opts.system` (`(msgs, tools, opts?) => reply`) —
  additive, so existing `(msgs, tools)` models and the engine's `model(msgs,
  specs)` call are unaffected.
- `withSystem(model, system)` (`@junejs/core/agent-runtime`) wraps a model to
  carry the system prompt per turn.
- `AgentDef` / `DoAgentDef` gain `instructions?`; `NativeRuntime` / `MemoryRuntime`
  / `AgentDurableObject` inject it via `withSystem` when building each session —
  single-sourced on the def, impossible to drop. `anthropic()` reads the per-call
  `opts.system` (falling back to its construction-time `system`).

Bonus: one `anthropic()` model instance can now serve many agents/subagents, each
supplying its own instructions per turn.
