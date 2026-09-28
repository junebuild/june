---
title: "Durable turns: a turn is a process, not a request"
nav: "Durable turns"
description: A June turn is a checkpointed, replayable stream of typed events. It can be streamed live, parked for a human, cancelled, reset, or started by the agent itself.
date: 2026-09-27
section: Agents
order: "16.4"
sources: [docs/rfc-turn-as-live-process.md, packages/core/src/agent-runtime.ts, packages/core/src/agent-config.ts, packages/core/src/agent-models.ts, packages/core/src/channels.ts, packages/june/src/agent-native.ts, packages/june/src/turn-events.ts, packages/june/src/agent-durable.ts]
---
## The model

A turn is not one model call that returns a string. It is a loop the engine
drives step by step: ask the model, run the tools it asked for, ask again, until
the model answers without calling a tool. Every step is checkpointed to the
session's store as it finishes.

The engine depends on three seams only (`SessionStore`, `EventSink`, `Model`),
so the same code runs on the native SQLite runtime in dev and inside a
Durable Object on Workers.

Two tables hold a session's state:

- **The message log** (`user`, `trigger`, `assistant`, `tool` messages) *is*
  the conversation. The loop's position is read straight off it.
- **The steps table** memoizes each step under a stable id: `model:<n>` for a
  model call, `tool:<n>:<callId>` for a tool call (`n` is the transcript index
  of the assistant message that made the call). A step with a stored result is
  skipped.

## Checkpoints and replay

A model step commits its reply and the assistant message in one transaction. A
tool step commits its result and the `tool` message the same way. If the process
dies mid-turn, delivering the same `turnId` again replays it: the opening
message isn't appended twice (`hasOpeningMessage`), finished steps are skipped,
and the loop picks up at the first step with no stored result. Calls still owed
a result are read off the transcript, not the step cache, so a crash in the
middle of a batch of tool calls resumes the remaining calls.

Live tokens are never persisted. On replay a cached model step emits nothing, so
a subscriber never sees text typed twice.

A provider that stops abnormally (`max_tokens`, `content_filter`, `refusal`, …)
with an empty reply fails the model step *before* it commits, instead of
completing the turn with silence. A reply that has content still commits.

## Sync and async tools

The engine classifies a tool by how its `run` is declared, and the class decides
the delivery guarantee:

| `run` is | class | guarantee | how |
| --- | --- | --- | --- |
| a plain function | local | **exactly-once** for the step, and for writes made through `ctx.store.unwrap()` | those writes + checkpoint + transcript append in **one** synchronous transaction |
| an `async` function | remote | **at-least-once** | awaited, then checkpoint + append in one transaction |

The transaction covers the session store's own handle and nothing else. A sync
tool that writes to another database, calls an API, or causes any other effect
gets no rollback with the checkpoint: a crash after the effect but before the
commit re-runs it. Treat such effects as at-least-once and make them idempotent.

To make an app write exactly-once, do it through the store handle — the host's
synchronous SQLite natively, `ctx.storage.sql` in a Durable Object. That handle is
on the raw tool context (`ToolContext.store`), so this takes a raw `Tool`; a
`defineAction`'s `run` gets only `{ user }`:

The handle is the backend's own, so a portable tool branches on its shape: the
native sync SQLite binds with `query(sql).run(...)`, the Durable Object's
`ctx.storage.sql` with `exec(sql, ...bindings)`. The in-memory backend has no
handle (and no rollback), so the helper refuses there instead of writing nowhere, and fails the turn with a `FatalToolError`, since the model can't fix a deployment:

```ts
// app/agent/tools/create_order.ts
import { FatalToolError, type Tool, type ToolContext } from "@junejs/core/agent-runtime";

type NativeSql = { query(sql: string): { run(...params: unknown[]): unknown } };
type DurableSql = { exec(sql: string, ...params: unknown[]): unknown };

// A write that joins the step's transaction, on either SQL backend.
function storeWrite(ctx: ToolContext, sql: string, ...params: unknown[]): void {
  const h = ctx.store.unwrap<NativeSql | DurableSql | undefined>();
  // A deployment mistake, not something the model can retry: fail the turn.
  if (!h) throw new FatalToolError("this backend has no transactional store handle");
  if ("query" in h) h.query(sql).run(...params); // native: bun:sqlite / node:sqlite
  else h.exec(sql, ...params); //                     Durable Object: ctx.storage.sql
}

// sync, and every write goes through the store: a crash rolls back the order row
// together with the step, or commits both
const createOrder: Tool = {
  spec: {
    name: "create_order",
    description: "Place an order for an item.",
    input: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  },
  run: (input: { item: string }, ctx) => {
    storeWrite(ctx, "create table if not exists orders (item text not null)");
    storeWrite(ctx, "insert into orders (item) values (?)", input.item);
    return { item: input.item };
  },
};
export default createOrder;
```

An async tool can't join that transaction. If the process dies after its network
call returns but before the checkpoint commits, the replay calls it again. Make
async side effects idempotent: payments, emails, and tickets should carry a key
the remote side dedupes on. `defineAction` keeps the distinction. An `async run`
becomes a remote tool, a plain one stays local.

Two rules follow from classifying by declaration:

- Declare a tool that awaits anything `async`. A plain function that *returns* a
  Promise is classified local, and its result is committed immediately — both
  SQL stores `JSON.stringify` it, and a Promise serializes to `{}`. So the step
  and the transcript record `{}`, the model reads `{}` as the tool's result, and
  the real work keeps running outside the transaction with its outcome lost.
- On the in-memory backend `tx` has no rollback, so exactly-once only holds on
  the SQLite and Durable Object stores.

## When a tool throws

A tool that throws does not fail the turn: the error becomes that call's
result, so the model reads it on its next step and can react. It can retry, try
another path, or tell the user what went wrong. This covers a failed clone, a
404 from an API, a missing file or a busy sandbox, and it needs no `try` /
`catch` in each tool.

- **What the model reads.** The result is `{ error }`, holding the error's
  message, prefixed with its class when that isn't a plain `Error`
  (`QuotaError: quota exceeded`), and cut to 2,000 characters. The stack is
  never included. The Anthropic adapter sends it as a `tool_result` with
  `is_error: true`.
- **It is checkpointed like any result.** A replay doesn't re-run the failed
  call. A sync tool's transaction rolled back, so the side effects it wrote
  through the store are undone before the error is recorded.
- **Events show the failure.** `action.completed` carries `error`, and the
  Slack task timeline shows the call as an error.
- **Throw `FatalToolError` to fail the turn instead.** Use it for a mistake the
  model can't fix, such as a misconfigured deployment or a broken invariant;
  the `storeWrite` helper above does this. The runtime's own signals, parking
  for input and cancellation, keep propagating as before.

## Streaming turn events

Every turn emits typed `TurnEvent`s as it runs:

| event | when |
| --- | --- |
| `turn.started` | the turn opened; carries its `trigger` (`inbound`, `proactive`, or `resume`) |
| `reasoning.delta` / `message.delta` | live model tokens (not persisted, not replayed) |
| `message.completed` | an assistant message was committed with text |
| `action.requested` | the model asked for a tool call |
| `action.completed` | a tool call's result was committed; `error` is set when the tool threw (see [When a tool throws](#when-a-tool-throws)) |
| `input.requested` | the turn parked, waiting for a human |
| `input.resolved` | a parked turn's input was answered or retired; carries `outcome` (`answered` / `retired`) and `by`. Live only |
| `turn.completed` | final text |
| `turn.failed` | the error, plus `phase` (`model` / `tool`) and `step` when a step was in flight |
| `turn.cancelled` | the turn was cancelled; carries a `reason` |

`AgentSession` exposes the primitives: `start(input)` returns `{ turnId }` without
waiting, `observe(cb, { turnId })` subscribes, and `result(turnId)` resolves to
`completed`, `suspended`, `failed`, or `cancelled`. `turn(input)` is sugar for
start-and-await, and it is non-interactive (it rejects if the turn parks).

Channels get the stream through `ChannelContext.runStream`, which both the native
`mountAgent` and the Durable Object surface provide. The stream ends on the
turn's terminal event (`turn.completed`, `turn.failed`, `turn.cancelled`, or
`input.requested`):

```ts
import { mountAgent } from "@junejs/server/agent-native";

const { ctx } = mountAgent(agent, runtime);
for await (const e of ctx.runStream!("summarize this thread", { session: "s1" })) {
  if (e.type === "message.delta") process.stdout.write(e.text);
  if (e.type === "action.requested") console.log(`\n→ ${e.call.name}`);
}
```

On Workers the Durable Object's `POST /turn` responds with this stream as
`text/event-stream`. The chat endpoint pipes it through when the client sends
`Accept: text/event-stream` and otherwise returns `{ text }`.

## Human in the loop

A tool can stop the turn and wait for a person with `ctx.requestInput({ id,
prompt, schema?, answerers? })`. Only an **async** tool can park. In a sync tool
the call throws, because a local tool commits inside a transaction that can't be
left open. `defineAction` tools get an `ActionContext`, not the tool context, so
a parking tool is a plain `Tool`:

```ts
// app/agent/tools/issue_refund.ts
import type { Tool } from "@junejs/core/agent-runtime";

const issueRefund: Tool = {
  spec: {
    name: "issue_refund",
    description: "Refund an order once a human approves it.",
    input: { type: "object", properties: { orderId: { type: "string" }, amount: { type: "number" } }, required: ["orderId", "amount"] },
  },
  run: async (input: { orderId: string; amount: number }, ctx) => {
    const approved = await ctx.requestInput({
      id: "approve-refund", // stable within the turn: it keys the answer
      prompt: `Approve a $${input.amount} refund on order ${input.orderId}?`,
      schema: { type: "boolean" },
    });
    if (approved !== true) return { refunded: false };
    // the side effect goes AFTER the answer (see below)
    return { refunded: true };
  },
};
export default issueRefund;
```

The first call finds no answer and parks the turn. The engine writes one
`suspended` checkpoint holding the pending request, the tool call id, the turn's
opening text, its surface policy, and the inbound event (minus `raw`). It sets
the session status to `suspended` and emits `input.requested`. Nothing is held in
memory, so the process or Durable Object can be evicted while it waits.

Resuming stores the answer under `input:<turnId>:<id>` and replays the turn:

```ts
const session = runtime.session("ops", "s1");
const { turnId } = session.start({ userText: "refund order 42" });
const r = await session.result(turnId);
if (r.status === "suspended") {
  session.resume(turnId, r.request.id, true, { by: "U024BE7LH" });
  console.log(await session.result(turnId)); // completed, or suspended again
}
```

Things to know:

- **The parked tool runs again from the top on resume.** Its step never
  committed, so replay re-enters `run` and `requestInput` returns the stored
  answer. Anything before the `requestInput` call runs twice, so put side effects
  after it.
- **Answers are turn-scoped.** A later turn that asks with the same `id` parks
  again. An old approval never carries over.
- **Who may answer: `answerers`.** `requestInput` takes an optional `answerers`:
  - `{ user }` — exactly this identity, compared with the resumer's verified
    `by`. A resume whose `by` doesn't match, or that has no `by`, throws
    `ResumeAuthorizationError`. `by` must be an identity you verified, such as the
    user id from a signature-checked Slack interaction.
  - `{ policy, scope? }` — a rule only the app can decide ("the operators of
    mailbox scout", "a manager of this tenant"). The host evaluates it at resume
    time through the agent's `authorizeAnswer` hook; only a matching grant lets the
    resume through. `by` alone never answers a policy, and a grant never answers a
    `{ user }`.

  With no `answerers`, the default answerer is the turn's speaker — but only when
  the channel **attests** that identity (`event.user.attested`). Slack signs every
  event, so a Slack approval still defaults to the triggering user. A turn whose
  speaker isn't attested (an email, whose `From:` anyone can forge) refuses to
  park: `requestInput` throws, telling you to name an answerer. A turn with no
  inbound event (proactive, programmatic) keeps no restriction — the app drives
  its own resume.
- **Resuming a policy answerer.** `resume(turnId, inputId, input, { by, granted })`
  accepts a `{ policy }` answer only with a `granted` for exactly that policy and
  scope. A host builds it with `grantAnswer(session, resume, authorizeAnswer)` —
  the one async step, which may read the db — before the synchronous `resume`.
  `session.pending()` returns the input the session is parked on. Both are
  exported for hosts and custom surfaces, and `resumeStream` / `resumeDelivered`
  (and the Durable Object's `/resume`) carry the resumer's `principal` beside `by`
  so `authorizeAnswer` can use it. The Durable Object maps `ResumeAuthorizationError`
  to 403, and a wrong turn, a wrong input id, or a turn that isn't suspended to 409.
  An `authorizeAnswer` that throws (a db outage) is a 500 and the answer is not
  applied, so the same answer can be retried.
- **One park at a time.** While a session is suspended, `start()` rejects any
  other inbound turn by default (`ifSuspended: "reject"`) — the right thing for an
  interactive surface, where the person who would speak next is the one being
  asked. Redelivering the parked turn is allowed. A channel whose other party
  keeps talking regardless can hold the turn instead — see below.
- On Slack, `slackChannel` renders `input.requested` as Approve / Deny buttons.
  A click resumes with `true` or `false` and the clicker's verified id.

Declare `authorizeAnswer` on the agent (`agent.ts`, `defineAgent`, or
`DoAgentDef`) to decide `{ policy }` answerers. It runs at resume time — on the
Durable Object inside the request scope, so it can read the app's db and
services:

```ts
// app/agent/agent.ts
export default {
  name: "ops",
  // Return true to let this resumer answer the parked { policy, scope } request.
  authorizeAnswer: async ({ policy, scope, by, principal }) =>
    policy === "operator" && (await isOperator(principal, scope)),
};
```

### Input announcements

`session.pending()` tells you what one session is parked on, but only for a
session you already hold. To keep a cross-session index of everything waiting on
a person, declare `onInputAnnouncement` on the agent (`agent.ts`, `defineAgent`,
or `DoAgentDef`). It receives an `InputAnnouncement` for each change to a park:

- `parked` — a turn parked on `requestInput`; carries the request, the
  triggering event (`raw` stripped), and how many turns are held behind it.
- `held` — an inbound turn was held behind the park (see below); carries the new
  `queued` count.
- `resolved` — the park ended: `answered` by `by`, or `retired` by a session
  reset.

Delivery is durable, at-least-once, and in order. Each announcement is recorded
in the same transaction as the state change it reports, in an outbox in the
session's store, and removed only after the hook returns. A hook that throws
keeps it for the next flush, and a session rebuilt after a crash delivers what
the earlier one left. Every announcement carries a unique `id` — dedupe on it.
Nothing is recorded while no hook is set.

On the Durable Object the hook runs in the request scope, so it can write a
cross-session index with the ambient `db` directly. `session.flushAnnouncements()`
and `session.undeliveredAnnouncements()` are the plumbing hosts use; live
subscribers of the parked turn also get an `input.resolved` event when it is
answered or retired.

### Holding turns behind a park

Rejecting is wrong for a channel where the other party keeps talking regardless —
email, say, where a follow-up arrives while a draft awaits approval. Pass
`ifSuspended: "queue"` to hold the turn instead of rejecting it: it is recorded in
the session's own store (durable across a restart, idempotent per `turnId`,
`event.raw` stripped) and `start()` returns `{ turnId, queued: true }`. Held turns
run one at a time, oldest first, once the park resolves; a held turn that parks
again holds the rest behind it. The parked turn's own redelivery is never held —
it replays and re-parks as before — and a turn that runs now still goes after
turns a restart left held. A held turn stays held until it settles, so a crash
while it runs replays it rather than losing it, and a redelivery of a turn that
has already started is not held again. `ifSuspended: "queue"` cannot be combined
with `replace` — replacing would drop held turns that were accepted. `turn()`
does not take `ifSuspended`: a held turn has no result to await yet, so use
`start()`.

- `hostContext` rides with a held turn and comes back through `session.onDequeue`,
  called as the turn starts — so a host can reattach what the original caller
  would have (for example a delivered render).
- `session.heldTurns()` lists the held turns, oldest first. `session.drain()`
  starts the oldest one when the session can run it now (no park, nothing running
  or queued, no reset pending); a host calls it after rebuilding a session from
  the store, and every other drain is automatic. `session.pending()` gains a
  `queued` count — the approver's cue that the conversation moved on since the
  request was made.
- On the Durable Object, `POST /turn` accepts `ifSuspended`. `"queue"` needs
  `?deliver=1` or `?detach=1`; a streaming caller asking to be held is a 400,
  because a held turn's reply comes later, when nobody is streaming it. A held
  delivered turn's reply is rendered through its source channel when it runs, in
  whichever life of the object that is. `ctx.runDetached` and `ctx.runDelivered`
  take `ifSuspended` and return `queued: true` when the turn was held.

The native `mountAgent` host doesn't take `ifSuspended` yet — it has no delivered
mode to render a held turn's reply.

## Cancellation and replace

Cancellation takes effect only at a checkpoint boundary: before the opening
commits, before each model call, between model deltas, and between tool calls.
What committed stays committed. Tool calls in the batch that hadn't run get a
synthetic `{ cancelled: true }` result, so the transcript stays valid for the next
model call. The turn emits `turn.cancelled` with a reason:

| reason | from |
| --- | --- |
| `requested` | `session.cancel(turnId)` |
| `replaced` | a newer turn started with `replace: true` |
| `reset` | `session.reset()` |

`replace` is the debounce behavior: every unfinished turn on the session, running
or queued, is cancelled before the new one queues. It's opt-in per call
(`ctx.run(text, { replace: true })`, `/turn?replace=1` on the Durable Object), and
`slackChannel({ replaceInFlight: true })` turns it on for new messages and
mentions in a thread. The stale Slack reply ends with *"superseded by a newer
message"*. Replace never cancels a parked approval.

Cancellation is best-effort. The request lives in memory, so after a crash the
replay runs uncancelled.

## Session reset

`session.reset()` retires a session's history without changing its address. It
cancels unfinished turns (reason `reset`), then, in order on the turn chain,
archives the messages and steps under the current generation number, clears the
live tables, and sets the status back to `new`:

```ts
const { previousSession, generation } = await session.reset();
// previousSession === "s1#g0" — the archived rows stay in the archive tables
```

The next turn starts from an empty transcript with no initiator and no parked
approval. A stale park is archived with everything else, which is how you get
out of an approval nobody will answer. While the reset is pending, `resume()`
refuses and new turns may queue behind it. Channels reach it as
`ctx.resetSession({ session })`, and the Durable Object as `POST /reset`.

## Agent-initiated turns

A turn doesn't need an inbound message. `receive()` starts a proactive turn and
renders it to a target with the channel's own `deliver()`, the same renderer an
inbound reply uses:

```ts
import { receive } from "@junejs/core/channels";

await receive(slack, ctx, {
  seed: "Summarize today's open threads and post the highlights.",
  target: { channelId: "C-ops" },
  trigger: { kind: "proactive", by: "cron:daily" },
  session: "slack:C-ops:daily",
});
```

The seed is stored as a `trigger`-role message attributed to `by`, so the
transcript records that no human sent it. The Anthropic adapter sends it as a
normal user message. `receive` throws if the host has no `runStream` or the
channel has no `deliver()`. It never drops the turn silently.

## Per-source turn policies

One agent can behave differently per inbound channel, keyed on the event's
`source` (for example `slack`), which a user can't forge:

```text
app/agent/
  instructions.md         # base system prompt
  instructions.slack.md   # overlay for turns arriving from Slack
```

```ts
// app/agent/agent.ts
export default {
  name: "ops",
  surfaces: {
    slack: { mode: "replace", denyTools: ["issue_refund"] },
  },
};
```

- **Overlay.** The variant is appended to the base prompt by default. With
  `mode: "replace"` it becomes the whole system prompt for that source's turns.
- **`denyTools`** removes tools from that source's turns: they aren't listed to
  the model, and a hallucinated call fails as an unknown tool. It is enforced in
  code, so a prompt injection can't talk the model into the tool.
- The policy is saved with a suspend checkpoint, so a resumed turn keeps it.
- A `mode` with no matching `instructions.<source>.md` is an error at assembly.
  A policy for a source that no mounted channel emits logs a warning.

## Known limits

- **A mid-turn subscriber has no catch-up over the wire.** `observe(cb, { turnId,
  replay: true })` folds the logged events (`message.completed`,
  `action.requested` / `completed`, `turn.completed`) before live ones, but only
  in-process. It skips `turn.started`, `turn.failed`, `turn.cancelled`, and a
  pending `input.requested`. `runStream`, the Durable Object's SSE, and delivered
  renders all subscribe live when the turn starts, and there is no public
  events endpoint to reconnect to.
- **Anthropic thinking is off by default.** The transcript doesn't store
  thinking blocks yet, and replaying a tool-use turn under adaptive thinking
  requires echoing them back. `anthropic({ thinking: true })` opts in.
- **One pending `requestInput` per turn at a time.** Tools run sequentially.
- **No subagents on the Durable Object target.** A tool that spawns a child
  session throws there. Cross-DO wiring isn't implemented.
- **Cancellation isn't durable.** See above.

## Why it matters

The same checkpoint that makes a crash safe also lets a turn stop for a person
and pick up days later. The same event stream drives a Slack reply, an SSE chat,
and a scheduled nudge. And because the engine sits on three small seams, the
guarantees you test in dev are the ones that run on Workers.
