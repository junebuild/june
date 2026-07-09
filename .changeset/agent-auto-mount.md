---
"@junejs/core": minor
"@junejs/server": minor
---

Auto-mount the durable agent from `june.config` (build order step 4).

- `@junejs/core/config`: an `agent.runtime` block (`enabled` / `dir` / `backend` /
  `chat.path` / `channels`), resolved by `resolveAgent`. `channelFetch` now
  returns `Response | null` so it composes as a fall-through surface.
- `@junejs/server`: the shared render pipeline gains an `agentSurface` slot (runs
  after the static agent surface `/mcp` + discovery, before middleware/routes).
  `mountAgent` gains `surface` — a framework chat endpoint at `chat.path` (POST
  `{message, session?}` → a durable turn) plus the discovered channels. The dev
  server auto-discovers an `agent/` directory and mounts it with an Anthropic
  model: drop an `agent/` folder and `POST /message`, `/channels/*`, and `/mcp`
  (its tools) are all live — no glue.

Edge (worker.ts + Durable Object routing) is a follow-up; dev auto-mount ships now.
