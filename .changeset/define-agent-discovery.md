---
"@junejs/core": minor
"@junejs/server": minor
---

Add `defineAgent` + directory discovery (agent-runtime build order step 2).

- `@junejs/core/agent-config` — `defineAgent()` assembles an agent from config +
  tools + skills. `actionToTool()` bridges a `defineAction` into a runtime `Tool`
  (sync ⇒ exactly-once local, async ⇒ at-least-once remote), so an agent's tools
  ARE your server actions — no new tool concept. `readSkillTool` +
  `buildSystemPrompt` give progressive skill disclosure.
- `@junejs/server/agent-discover` — `discoverAgent(dir)` scans the `agent/`
  directory convention (`agent.ts` + `instructions.md` + `tools/*.ts` +
  `skills/*.md`) into an `AgentDefinition`, ready to mount with
  `createNativeRuntime({ [name]: { model, tools } })`.
