# Supervision API — end-to-end POC (#297)

Throwaway. It checks P1b's requirements against the real engine before they are split into
PRs: a `NativeRuntime` parks turns, a pending-actions index is fed by input announcements
(#260), and an operator drives `/_june/inbox/v1` with a June-issued token.

```sh
bun test poc/supervise-e2e     # 7 scenarios, all passing (2026-09-28)
```

- `src/token.ts`: the minimal June token. A JWT signed HS256 with an app secret through
  WebCrypto, so the code runs on Bun, Node and workerd. The claims are `sub`, `scope`
  (space-separated), `iat`, `exp`, `jti` and `aud: "june:inbox"`. Verification pins the
  algorithm; the header's `alg` is never trusted.
- `src/supervise.ts`: the index (its own SQLite) and the routes:
  - `GET /pending` returns a `PendingPage`.
  - `GET /pending/:id` returns `{ pending, trace }`.
  - `POST /pending/:id/decision` takes a `Decision` and answers 200, 403 or 409.
  - A new `authorize({ principal, agent, action, pending })` guards both reads and decisions,
    and denies when the app has not set it.
- `scenarios.test.ts`: the requirements, one test each.

## What works as designed

| requirement | result |
|---|---|
| A park appears in the index with its prompt and answerers, the tool call that parked (`send_reply` and its input), and the trimmed Slack origin | ✅ |
| `GET /pending/:id` includes the `traceTurn` trace, with the parked call `pending` | ✅ |
| Approving a `{ policy }` park resumes the turn; the tool receives `true`; the resolution records `decision: "approve"` and `by: "op:ada"` | ✅ |
| Two concurrent decisions: one gets 200, the other gets 409 `already_resolved`, whose resolution names who decided | ✅ |
| Reject with a note: the tool receives `false`, and the model reads the note right after the tool result | ✅ (only with the workaround in F3) |
| An inbound message held behind the park raises `queued` to 1 | ✅ |
| A missing token, a forged signature, an expired token or `alg: none` gets 401; a token without the needed scope gets 403 | ✅ |
| A read-only operator can read (200) but not decide (403); a non-operator sees nothing: 404, and an empty list | ✅ |

## Findings

**F1 — an operator cannot answer an ordinary Slack park (test `F1`, confirmed).** When the tool
names no answerer, the default is the attested speaker, `{ user: "U_GRACE" }`. The engine
compares the resumer's `by` to that id verbatim. An operator authenticated as a June principal
(`op:ada`) therefore gets 403, and only the Slack button can answer it. "Approve works without
Slack" (RFC §11 P1b) holds today only for `{ policy }` parks. Two ways out:

- **(a) Any-of answerers.** `Answerers` becomes one rule or a list of rules, and the default
  for an agent with supervision on becomes `[{ user: speaker }, { policy: "operators" }]`.
  The speaker keeps their button, and operators can answer too. This is an engine change to
  `resume` and `grantAnswer` and a contract change to `Answerers` (a closed set, so contract v2).
- **(b) Identity linking.** A principal carries its linked platform ids (`slack: "U…"`), and
  the host passes them as `by` candidates. This needs account linking, which June does not
  have (#300).

**F2 — no app can supply an identity (#300).** `createPipeline`'s `identity` seam is not wired
by either host and has no config key, so the June token has to be its own identity provider.
Filed as #300: the token should plug into that seam, not sit beside it.

**F3 — reject-with-note needs an atomic resume (confirmed).** The note must enter the session
before the resumed turn runs, since `note()` and the turn share one chain. It must also enter
only if the answer is accepted, or a denied reject would leave an orphaned note behind. With
`resume()` first and `note()` second, the model never reads the note: the reject test fails.
The POC instead re-implements the engine's answerer check before queuing the note, which
duplicates engine logic. The fix is `resume(turnId, inputId, input, { by, granted, note })`,
recorded in the resume's own transaction.

**F4 — no public read of a session's log.** `traceTurn` needs the `Msg[]`, but `AgentSession`
exposes only `transcript()` (the older fold, which drops tool inputs). The POC reaches into
`store`. The fix is `AgentSession.messages()`, or a `trace(turnId)` method.

**F5 — the index cannot share the runtime's database.** `NativeRuntime` keeps its SQLite handle
private, and `june dev` runs the runtime on `:memory:`. A server-owned index needs either a
handle from the runtime or its own table created in the runtime's database. Dev also loses its
index on every restart; reconciling against `pending()` on startup would recover the pending
rows, but not the history.

**F6 — the resolved announcement does not say which decision was made.** It carries `outcome:
"answered"` and `by`. The POC records the decision on the side before resuming. A Slack
Deny click resolves as a plain "answered". An optional `decision` passed through `resume` would
make every surface's resolution complete.

**Not covered:** the edge. Each Durable Object holds one session and cannot enumerate the
others, so the index needs its own Durable Object class and a new migration tag. That is the
biggest piece of P1b and is untested here. Restart recovery of the index is also untested.
