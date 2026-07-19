---
"@junejs/server": patch
---

Failed turns are no longer silent on the edge (#76): AgentDurableObject now
`console.error`s every `turn.failed` by default — visible in `wrangler tail`,
where a turn that dies after the fast-ACK previously had no observable surface
at all. A new `onTurnError` hook on `DoAgentDef` lets the app take over
reporting (Sentry, a ledger, …); if the hook itself throws, the default log
fires anyway, so a failure can never go unreported. One seam on the session
sink covers every turn path: `turn()`, `POST /turn`, and `POST /resume`.
