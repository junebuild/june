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
| a plain function | local | **exactly-once** | side effect + checkpoint + transcript append in **one** synchronous transaction |
| an `async` function | remote | **at-least-once** | awaited, then checkpoint + append in one transaction |

```ts
// app/agent/tools/create_order.ts
import { defineAction } from "@junejs/core/agent";

// sync → exactly-once: a crash either rolls the whole step back or commits it
export default defineAction({
  id: "create_order",
  description: "Place an order for an item.",
  input: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  run: (input) => ({ orderId: 1, item: input.item }),
});
```

A local tool that needs its own table can write it inside the same transaction
through `ctx.store.unwrap()`: the host's synchronous SQLite handle natively,
`ctx.storage.sql` in a Durable Object.

An async tool can't join that transaction. If the process dies after its network
call returns but before the checkpoint commits, the replay calls it again. Make
async side effects idempotent: payments, emails, and tickets should carry a key
the remote side dedupes on. `defineAction` keeps the distinction. An `async run`
becomes a remote tool, a plain one stays local.

Two rules follow from classifying by declaration:

- Declare a tool that awaits anything `async`. A plain function that *returns* a
  Promise is classified local, and the unresolved Promise is what gets committed.
- On the in-memory backend `tx` has no rollback, so exactly-once only holds on
  the SQLite and Durable Object stores.

## Streaming turn events

Every turn emits typed `TurnEvent`s as it runs:

| event | when |
| --- | --- |
| `turn.started` | the turn opened; carries its `trigger` (`inbound`, `proactive`, or `resume`) |
| `reasoning.delta` / `message.delta` | live model tokens (not persisted, not replayed) |
| `message.completed` | an assistant message was committed with text |
| `action.requested` | the model asked for a tool call |
| `action.completed` | a tool call's result was committed |
| `input.requested` | the turn parked, waiting for a human |
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
prompt, schema?, answererId? })`. Only an **async** tool can park. In a sync tool
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
- **`answererId` is enforced.** It defaults to the triggering user
  (`event.user.id`). When it is set, a resume whose `by` doesn't match throws
  `ResumeAuthorizationError`, and so does a resume with no `by` at all. The Durable
  Object maps that to 403, and a wrong turn, a wrong input id, or a turn that
  isn't suspended to 409. `by` must be an identity you verified, such as the user
  id from a signature-checked Slack interaction. With no `answererId` and no
  triggering user, any resumer is accepted.
- **One park at a time.** While a session is suspended, `start()` rejects any
  other turn. Redelivering the parked turn is allowed.
- On Slack, `slackChannel` renders `input.requested` as Approve / Deny buttons.
  A click resumes with `true` or `false` and the clicker's verified id.

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
