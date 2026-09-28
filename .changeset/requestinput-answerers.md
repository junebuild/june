---
"@junejs/core": minor
"@junejs/server": patch
---

`requestInput` answerers: who may answer a parked input, including rules only the app can decide (#261).

**Breaking:** `answererId: string` is replaced by `answerers`:

- `{ user }` — exactly this identity, compared with the resumer's verified `by`, as `answererId` was.
- `{ policy, scope? }` — a rule the app decides at resume time ("the operators of mailbox scout",
  "a manager of this tenant"), through the agent's new `authorizeAnswer` hook.

Migrate `requestInput({ …, answererId: "U123" })` to `requestInput({ …, answerers: { user: "U123" } })`.

**The default answerer is now the turn's speaker only when its channel attests that identity**
(`InboundEvent.user.attested`). The Slack channel attests every event it normalizes — Slack signs
them — so Slack approvals behave as before. An inbound turn whose speaker is not attested (for
example an email, whose `From:` anyone can forge) used to make that external sender the
approver; now `requestInput` without `answerers` refuses to park there and says to name one.
Turns with no inbound event (proactive, programmatic) are unchanged.

- `authorizeAnswer?: AuthorizeAnswer` on `agent.ts`'s config, `defineAgent`, and `DoAgentDef`;
  `assembleAgent` / `assembleDurable` carry it. The native `ctx.resumeStream` and the Durable
  Object's `/resume` evaluate it before the synchronous resume (on the DO inside the request
  scope, so it can read the app's db and services) and pass the grant on.
- `resume(…, { by, granted })` accepts a `{ policy }` answer only with a grant for exactly that
  policy and scope; `by` alone never answers a policy, and a grant never answers a `{ user }`.
- `grantAnswer(session, resume, authorize)` and `AgentSession.pending()` are exported for hosts
  and custom surfaces; `resumeStream` / `resumeDelivered` and the `/resume` body accept the
  resumer's `principal` beside `by`.
