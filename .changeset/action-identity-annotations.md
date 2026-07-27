---
"@junejs/core": minor
---

Actions gain identity + standards-aligned metadata; connections gain per-call identity.

- `defineAction({ requiresPrincipal })`: one identity gate, enforced on EVERY
  dispatch path — `invokeAction` (UI POST, /mcp tools/call, Flight) rejects when
  `ctx.user` is absent, and `actionToTool` copies the flag so the turn engine
  hides the bridged tool from anonymous turns entirely.
- `actionToTool` now threads the turn's identity: `ToolContext.principal` maps
  onto `ActionContext.user` — the same field a UI or /mcp dispatch carries — so
  one authorization check inside an action covers every path (this was
  previously an empty `{}` with a "threads real identity later" comment).
- `defineAction({ annotations })`: MCP ToolAnnotations (2025-11-25 —
  readOnlyHint/destructiveHint/idempotentHint/openWorldHint/title). Advisory
  metadata; June's /mcp gateway re-serves them so MCP clients can drive
  permission UX. A connection carries a remote MCP tool's annotations through
  unchanged (gateway fidelity).
- Connection `auth` is now `(ctx?: ActionContext) => {token}` — resolved per
  call with the caller's identity, so an auth can mint per-tenant short-lived
  credentials instead of holding one static key. Called without ctx at
  discovery time (initialize/tools/list/OpenAPI doc fetch); zero-arg auths are
  unaffected (backward compatible).
- Connection `requiresPrincipal` stamps every action the connection exposes —
  a tenant-scoped remote's tools are invisible on anonymous turns.
