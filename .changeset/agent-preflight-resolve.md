---
"@junejs/server": patch
---

Agent SDK preflight: explicit node_modules walk instead of Bun.resolveSync (#139).

The build preflight that verifies `@anthropic-ai/sdk` is installable before emitting the durable-agent entry relied on `Bun.resolveSync`, which missed a symlinked scoped package on Linux while finding it on macOS — the agent-build suite failed on CI and `main`'s check went red. The preflight now walks `node_modules/@anthropic-ai/sdk/package.json` upward from the app root with `existsSync`: identical behavior on every host, symlinks followed. It is a presence check, not the resolver — Rolldown still performs the real resolution at bundle time.
