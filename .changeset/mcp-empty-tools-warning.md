---
"@junejs/core": patch
---

`/mcp` now warns (once per process) when `tools/list` is served an empty tool set.

An enabled `/mcp` surface returning zero tools is almost always the silent no-op
where a `defineAction()` sits in a file the app graph never imports (a standalone
`app/actions.ts` is not auto-loaded). Previously `tools/list` returned `[]` with no
signal, so the misconfiguration surfaced only as "my agent sees no tools". The
warning points to the fix: agent tools live in `agent/tools/*.ts`, each
default-exporting a `defineAction`.
