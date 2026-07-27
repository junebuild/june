---
"@junejs/core": patch
---

Channel identity seam: WHO IS SPEAKING becomes a first-class, trusted turn input.

- `crispChannel({ resolveIdentity })`: before any consumer of a normalized event runs
  (the turn AND the observers — observe-mode shadow pipelines included), the channel
  pulls the conversation's verification evidence over authenticated REST and hands it
  to the resolver as a `CrispIdentity`: `verified`/`email`/`method` derive only from
  Crisp's `verifications` array with backend-asserted methods (`sdk` — the chatbox
  HMAC email signature — or `api`); client-writable `meta`/session-data ride along as
  clearly-separated hints. The resolver maps a trusted email to the app's own
  `Principal` (the same type `ActionContext.user` carries — one identity model across
  UI, /mcp, and channel turns). Fail-closed everywhere: a failed lookup arrives as
  `{ fetched: false, verified: false }`, a throwing resolver reports to `onError` and
  the turn runs anonymous.
- `InboundEvent.principal` + `ToolContext.principal`: the resolved principal rides the
  event across the /turn RPC, survives suspend checkpoints, and is mirrored onto every
  tool's ctx — tools key tenant-scoped queries and credentials off it, never off
  model-supplied input.
- `Tool.requiresPrincipal`: on a turn without a principal the tool is absent by
  construction — not listed to the model, not resolvable by a hallucinated call
  (fails loudly as unknown tool). Prompt injection cannot reach data tools on an
  anonymous conversation.
- `crispChannel({ tier })`: `"plugin"` (default) or `"website"` — sets `X-Crisp-Tier`
  on all outbound REST, supporting dashboard-generated website tokens.
- `deriveCrispIdentity` is exported (pure) so hand-rolled channels and tests reuse the
  trust rule.

slackChannel gains no resolver yet; the principal plumbing is channel-agnostic and a
slack identity seam can follow the same shape.
