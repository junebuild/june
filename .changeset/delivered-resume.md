---
"@junejs/core": patch
"@junejs/server": patch
---

Delivered resume — a HITL continuation now survives the edge waitUntil ceiling, and the
Approve/Deny buttons can require native confirmation.

An approved/denied turn's continuation was consumed by the webhook isolate inside
`ctx.waitUntil`: a continuation running past the post-ACK grace was cancelled silently,
leaving the prompt stuck on "_Working…_" forever. This completes the delivered-turns story
(the reply-bearing inbound leg shipped earlier):

- **`POST /resume?deliver=1`** (AgentDurableObject): applies the answer, 202s, and renders
  the continuation through the source channel's new **`deliverResume()`** under the DO's
  own lifetime. Capability is refused with a **501 before the answer applies** — the
  `DeliverUnsupportedError` contract, so a consumer-side fallback cannot double-answer
  (the engine would 409 the second apply). Engine rejections (403 unauthorized clicker /
  409 stale-or-double click) pass through with their meaning intact.
- **`ctx.resumeDelivered`** (ChannelContext, provided by `durableChannelSurface`) exposes
  it; **slackChannel** prefers it on Approve/Deny clicks and falls back to `resumeStream` +
  worker-side rendering only on the typed refusal. Rejections keep today's UX: an
  ephemeral note to the clicker, buttons intact for the rightful answerer.
- **One renderer, two isolates:** the continuation renderer (progress → outcome / failure
  / next approval, updating the prompt message in place) is now a single function shared
  by the worker-side fallback and `deliverResume`. New exported `ResumeDeliveryTarget`.
- **`approvalConfirm`** (slackChannel, off by default): attaches Slack's native
  confirmation dialog to the Approve/Deny buttons — a modal must be confirmed before the
  interaction fires (the Deny dialog styled danger). Fat-finger protection for approval
  buttons in busy channels.
