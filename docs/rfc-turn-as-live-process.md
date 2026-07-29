# RFC: The turn as a live process

Status: **proposal / draft** · Stage: v0 (no back-compat constraint — we optimize for the
right long-term shape) · Scope: `@junejs/core` agent-runtime, `@junejs/server` durable/native
edges, channel contract.

## Summary

Today a June turn is a **request → response**: `AgentSession.turn() => Promise<string>`. The
model is called once, the loop runs, and one final string comes out. That was the right shape
for a chatbot. It is the wrong shape for an agent.

An AI-era turn is a **live process**: it streams (reasoning, partial text, tool calls as they
happen), it can **pause for input** (approval, a form, a disambiguation) and resume later, and
it can be **started by the agent itself** (a schedule, another channel, a follow-up) — not only
by an inbound user message.

This RFC redesigns the core so a **turn IS a durable stream of typed events**. The final string
becomes a derived convenience, not the primary interface. Crucially, this is **less of a rewrite
than it looks**: June's durable log-replay engine — today used only for crash recovery — is
already the machine that suspend/resume and proactive turns need. We are mostly *exposing* an
event-driven, resumable engine that already exists underneath a one-shot façade.

## 1. Motivation

Three capabilities are missing, and all three trace to the same one-shot assumption:

1. **Liveness** — a channel can only `await` one string, so a Slack surface can't show
   "Thinking…", stream partial answers, or surface the agent's reasoning/steps as they happen.
2. **Interactivity** — a turn cannot stop mid-flight to ask a human ("approve this refund?",
   "which order?") and continue after the answer. HITL is impossible without forking the runtime.
3. **Agency** — a turn can only be *triggered by an inbound message*. The agent can't initiate
   (post a proactive nudge, run on a schedule, hand off to another channel).

Peer frameworks (e.g. eve) bake liveness + HITL + proactive delivery into a heavy,
platform-coupled channel layer. We can get the same capabilities **as generic, portable
primitives** — because our durable core is already the right substrate.

## 2. Current architecture — where "one-shot" lives

Three load-bearing seams encode the request→response assumption:

| Seam | Today | The constraint |
| --- | --- | --- |
| **Model** | `Model = (msgs, tools, opts?) => Promise<ModelReply>` | one call, one reply; no deltas |
| **Turn output** | `AgentSession.turn() => Promise<string>`; `runTurn() => Promise<string>` | a turn is a promise of final text |
| **Channel** | `ctx.run(msg) => Promise<string>` → post once | no lifecycle, one delivery |

### The latent asset

Underneath, the engine is **already event-driven and resumable** — we just don't expose it:

- **`Broadcaster.publish(turnId) / subscribe(cb)`** is an event spine. It's coarse (it carries
  only a turnId "something changed" poke and observers re-fold the transcript), but the spine exists.
- **Step-checkpoint + log-replay** (`getStep`/`putStep` + `messages` log) already means "a step
  with no persisted result runs; a step with one is skipped." That is *exactly* the primitive
  suspend/resume needs: suspend = "no result yet, park"; resume = "append the result, continue."
- **The anthropic adapter already streams** — `client.messages.stream(...)` (`agent-models.ts:92`) —
  and then throws the stream away with `.finalMessage()` (`agent-models.ts:100`). The tokens are right there.
- **SSE / live transport already ships** for the dev live-reload (`packages/june/src/dev-reload.ts` —
  the one `text/event-stream` + `EventSource` implementation).

So the work is: **promote the spine to typed events, stop discarding the model stream, and add a
resume entry point.** Not a new engine.

## 3. Design principles

1. **Streaming-first.** The model yields a stream; a one-shot reply is the degenerate case
   (a stream of length 1). Not the reverse.
2. **A turn is an event source.** `TurnEvent`s are the interface. `text` is folded from them.
3. **Durable by default, live when connected.** Structural events are reconstructable from the
   log (a reconnecting client catches up); token-level deltas are live-only (not replayed).
4. **The channel renders the stream.** Fast-ACK stays; the background work streams events the
   channel renders (typing, partial edits, reasoning, approval prompts) instead of awaiting a string.
5. **Pause and proactivity are first-class**, built on the checkpoint model — not bolted on.
6. **Portable & generic.** No platform lock-in; the same primitives serve Slack, Crisp, HTTP, CLI.

## 4. Core — the `TurnEvent` stream

```ts
export type TurnEvent =
  // ── structural (durable: foldable from the message/step log; replayed on reconnect) ──
  | { type: "turn.started";     turnId: string; trigger: TurnTrigger }
  | { type: "action.requested"; turnId: string; call: ToolCall }
  | { type: "action.completed"; turnId: string; call: ToolCall; result: unknown }
  | { type: "message.completed"; turnId: string; text: string }        // an assistant message finalized
  | { type: "input.requested";  turnId: string; request: InputRequest } // turn suspended here
  | { type: "turn.completed";   turnId: string; text: string }
  | { type: "turn.failed";      turnId: string; error: { message: string } }
  // ── live (ephemeral: emitted only during live execution, NOT on replay) ──
  | { type: "reasoning.delta";  turnId: string; text: string }
  | { type: "message.delta";    turnId: string; text: string };

export type TurnTrigger =
  | { kind: "inbound"; event: InboundEvent }        // a channel event (message, mention, reaction)
  | { kind: "proactive"; by: string; note?: string } // a schedule, another channel, the agent itself
  | { kind: "resume"; callId: string };              // continuation after an input.requested suspend
```

**Two tiers, one stream.** Structural events have a durable counterpart in the log, so
`foldTranscript` can reconstruct them for a late subscriber; `*.delta` events are live-only
(a reconnecting UI gets the completed message, not a re-typed one). This split is what lets the
same abstraction serve both a live SSE viewer and a durable transcript without double-storing tokens.

## 5. The Model seam — streaming-first

```ts
export type ModelDelta =
  | { type: "reasoning"; text: string }         // thinking tokens (adaptive thinking)
  | { type: "text"; text: string }              // assistant answer tokens
  | { type: "tool_call"; call: ToolCall }        // a tool call as it finalizes
  | { type: "done"; reply: ModelReply };         // terminal: the authoritative assembled reply

export type Model = (msgs: Msg[], tools: ToolSpec[], opts?: ModelOpts) => AsyncIterable<ModelDelta>;
```

- The engine iterates the model: it forwards `reasoning`/`text` as live `TurnEvent`s and reads the
  terminal `done.reply` as the value to **checkpoint** (the adapter owns assembly — anthropic's
  `finalMessage()` already produces exactly this). The engine never re-derives tool calls from
  partial deltas; `done.reply` is authoritative.
- A one-shot / scripted model is trivial and honest about being non-streaming:
  ```ts
  const scripted: Model = async function* (msgs) { yield { type: "done", reply: pick(msgs) }; };
  ```
- The anthropic adapter changes from "stream → throw away → finalMessage" to "stream → yield
  deltas → yield done(finalMessage)". Same SDK call, nothing discarded.

Rationale for streaming-first (vs an `onDelta` callback bolt-on): at v0 we want the shape that a
modern agent runtime *is*, not the smallest diff. A callback hides streaming as a side effect of a
one-shot call; an `AsyncIterable` makes the stream the truth and one-shot the special case.

## 6. The turn engine — emits events, derives text

`runTurn` becomes an event producer over an `EventSink` (the promoted Broadcaster):

```ts
export interface EventSink { emit(e: TurnEvent): void; }
// AgentSession keeps a per-session sink; observers/SSE subscribe to it.
```

The loop, unchanged in structure, now emits at each boundary it already has:

- append user/trigger message → `turn.started`
- `modelStep`: iterate the model → emit `reasoning.delta` / `message.delta` live; on `done`,
  checkpoint the reply, append the assistant message → `message.completed` (+ `action.requested`
  per tool call)
- `toolStep`: before → nothing; run; commit → `action.completed`
- loop ends → `turn.completed` (or `turn.failed` on throw; `input.requested` + park on suspend)

The public surface:

```ts
class AgentSession {
  // kick off; returns immediately with the id. Events flow to the sink.
  start(input: TurnInput): { turnId: string };
  // subscribe to this session's event stream (live + a replayed structural prefix for a turnId).
  observe(cb: (e: TurnEvent) => void, opts?: { turnId?: string; replay?: boolean }): () => void;
  // await a terminal result (completed | suspended | failed) — the "just give me the answer" path.
  result(turnId: string): Promise<TurnResult>;
}

export type TurnResult =
  | { status: "completed"; text: string }
  | { status: "suspended"; request: InputRequest }   // parked, awaiting resume
  | { status: "failed"; error: { message: string } };
```

`turn(input): Promise<string>` can remain as one-line sugar (`start` + `result`, throwing on
non-completed) for CLI/tests — but it is no longer the primary interface, and callers that care
about liveness/interaction use `start` + `observe` / `result`.

## 7. Durability & replay semantics

- **What's persisted** (unchanged spine): the `messages` log + `steps` checkpoints. Structural
  `TurnEvent`s are *derivable* from these via `foldTranscript` — we do not store events separately.
- **Live deltas are not persisted.** On crash/replay, a cached `modelStep` is skipped, so no
  `*.delta` is re-emitted; the engine emits `message.completed` from the cached reply instead. A
  reconnecting subscriber therefore sees a coherent, non-duplicated history (completed messages)
  plus live deltas from the reconnection point forward.
- **Reconnect / late subscriber**: `observe({ turnId, replay: true })` first emits the folded
  structural prefix (turn.started, completed messages, actions, and a pending `input.requested` if
  suspended), then live events. Exactly-once side effects are unaffected — this is a read path.

## 8. Interaction — suspend / resume (HITL)

The crown jewel, and nearly free on the checkpoint model.

A tool (or the model via a reserved `request_input` tool) asks for external input:

```ts
// inside a tool's run(input, ctx):
const decision = await ctx.requestInput({
  id: "approve-refund",                 // stable within the turn (keys the checkpoint)
  prompt: "Approve a $120 refund to Ada?",
  schema: { type: "object", properties: { approved: { type: "boolean" } } },
});
```

Protocol:

1. `requestInput(req)` looks up a **resume step** keyed by `req.id` in the store.
   - **Present** (we are replaying after a resume) → return the stored input. The tool continues
     as if it had blocked. No suspend.
   - **Absent** → the engine emits `input.requested`, persists `status = "suspended:{id}"` + the
     pending `InputRequest`, and throws a `Suspend` sentinel.
2. `runTurn` catches `Suspend`, commits the suspended state, and **returns** `TurnResult{status:
   "suspended", request}`. The isolate can be evicted safely — the state is durable.
3. The channel renders `input.requested` (Slack Block Kit buttons, an ephemeral form, …) to the
   right user, using the trigger's identity.
4. When the human answers, the channel calls `session.resume(turnId, req.id, input)`:
   - append the input as the resume step's result, clear suspended status, and **re-run
     `runTurn`**. Replay skips completed steps; `requestInput` now finds its input and continues;
     live events resume from here. The resume is idempotent (a duplicate button click replays to
     the same result).

This reuses the exact durability contract that already guarantees exactly-once side effects across
a crash. Suspend is "a step whose result arrives from a human instead of a tool."

Design notes / open points: multiple concurrent `requestInput`s in one turn (sequential is the MVP);
timeouts / cancellation (`input.expired`); who is allowed to answer (bind to trigger user id).

## 9. Proactive / agent-initiated turns

A turn already accepts an optional trigger; proactivity needs two things:

1. **A non-inbound trigger + seed.** `session.start({ trigger: { kind: "proactive", by: "cron:daily" },
   seed: "Summarize today's open threads." })`. The seed is appended as the turn's opening message
   (a `trigger` role, or a synthetic user message) so the loop has something to act on.
2. **Outbound delivery to a target** (no inbound webhook to reply to). Channels gain:
   ```ts
   channel.deliver(target: DeliveryTarget, source: EventSink): Promise<void>;
   // e.g. Slack target = { channelId, threadTs? }; deliver subscribes to the turn's events and
   // posts/updates messages, same renderer as the inbound path.
   ```
   And a top-level `receive(channel, { seed, target, trigger })` to start a proactive turn and wire
   its stream to `deliver`. A schedule (CronCreate), another channel, or a tool can call it.

This makes "the agent posts a nudge at 9am" or "on resolve, the Slack surface hands off to the
Crisp thread" first-class, using the same event stream + channel renderer as reactive turns.

## 10. The channel contract — render the stream

`ctx.run` stops returning a string. A channel gets the turn's **event stream** and renders it:

```ts
type ChannelRun = (input: TurnInput) => { turnId: string; events: AsyncIterable<TurnEvent>; result: Promise<TurnResult> };

// a channel's inbound handler, conceptually:
slackChannel({
  respondTo: ["app_mention"],
  render: {
    onTurnStarted:   (e, ch) => ch.thread.typing("Thinking…"),
    onMessageDelta:  (e, ch) => ch.thread.editStreaming(e.text),   // progressively edit one message
    onActionRequested: (e, ch) => ch.thread.status(`Running ${e.call.name}…`),
    onInputRequested: (e, ch) => ch.thread.prompt(e.request),      // Block Kit buttons
    onCompleted:     (e, ch) => ch.thread.finalize(e.text),
  },
});
```

Built-in default renderers (an `indicators: true`-style preset) give the eve-like "Thinking…/
Working…/final" UX for free; power users override per event. The observe/onEvent/on[kind] hooks
from dev.2–dev.4 stay for *side-channel* observation; `render` is for *reply UX* driven by the
turn's own lifecycle.

## 11. Transport (edge + native)

- **Native**: same process — the channel subscribes to the session's sink directly.
- **Edge (Durable Object)**: the turn runs in the DO; the channel runs in the worker (different
  isolate). The DO's `/turn` becomes a **streamed response** (`text/event-stream` of `TurnEvent`s)
  instead of `{ text }`. The worker consumes the SSE and drives the channel's `render`. A suspend
  ends the stream with `input.requested`; `resume` is a new `/turn/:id/resume` streamed request that
  continues. A logical turn = one or more physical streamed responses stitched by `turnId`.
- **Edge caveat — the waitUntil ceiling, and delivered turns.** A worker-side render consumer
  lives inside `ctx.waitUntil`, which the runtime cancels ~30s after the ACK response ends — a
  longer turn's rendering dies mid-flight, and cancellation is not an exception (no `turn.failed`,
  no reply, silence). `?detach=1` rescued reply-DROPPING turns; **`?deliver=1` is the
  reply-BEARING sibling**: the DO 202s on acceptance and renders the turn's event stream through
  the source channel's own `deliver()` (§9's renderer) from inside the DO, under the DO's own
  lifetime. `ctx.runDelivered` exposes it to channels; a host that can't deliver refuses with
  `DeliverUnsupportedError` *before* starting the turn, so a channel may fall back to worker-side
  rendering without double-running. (Resumed continuations still render worker-side — a delivered
  `/resume` is a tracked follow-up.)
- A public **`GET /agent/:session/turns/:id/events`** SSE surface (reusing the framework's existing
  SSE plumbing) lets a browser/ops UI subscribe with structural replay.

## 12. Phasing (shippable slices, even without back-compat)

1. **P1 — TurnEvent bus + structural events + SSE.** ✅ **Shipped.** Promote Broadcaster →
   `EventSink`; emit structural events from existing step boundaries; `observe` upgraded; DO
   `/turn` streams; channel `render` presets. Unlocks liveness UX with no model change.
2. **P2 — Streaming Model.** ✅ **Shipped.** `Model => AsyncIterable<ModelDelta>`; anthropic
   adapter yields deltas; engine emits `reasoning.delta`/`message.delta`. Progressive message
   rendering lands.
3. **P3 — Suspend / resume (HITL).** ✅ **Shipped** (P3 core + P3b Slack). `ctx.requestInput` +
   `session.resume` + `input.requested` rendering + Slack Block Kit interaction routing. The
   differentiator.
4. **P4 — Proactive.** ✅ **Shipped.** A `trigger`-role opening Msg (attributed, mapped to a user
   message at the adapter) seeds an agent-initiated turn via `start({trigger:proactive})`;
   `channel.deliver(target, events)` renders a turn's stream to a target with no inbound event;
   `receive(channel, ctx, {seed, target, trigger, session})` starts the proactive turn and wires
   its stream to `deliver`. Schedule/cross-channel initiation. The trigger threads through the
   edge (`serializeTurn` → DO `/turn` → `session.start`).

P1+P2 are foundational; P3 is the deep, high-value one; P4 is smaller and rides on P1's renderer.
All four phases are now shipped.

## 13. Migration impact (v0 — we change call sites, not preserve them)

- `Model` implementations become async generators (adapter + scripted models + tests). Small,
  mechanical.
- `AgentSession.turn/runTurn` gain event emission; the string-returning form becomes sugar over
  `start`+`result`. Channels move from `await ctx.run` to `render` over the stream.
- `Broadcaster` → `EventSink` (typed payload). `channelFetch`/`durableChannelSurface`/`mountAgent`
  thread the sink + streamed responses. Durable `/turn` response shape changes to SSE.
- The dev.1–dev.4 channel work (respondTo, on[kind], onEvent, ctx.services, channelInstructions,
  exported primitives, verify/normalize, channel.tools-in-DO) is **orthogonal and preserved** —
  `render` sits alongside it.

## 14. Resolved decisions (v0)

These were the open questions; resolved as follows and now binding **design commitments** —
realized across the P1–P4 phases below, **not** all implemented in the P1a event-bus slice. Each
note marks the phase that lands it.

1. **Event granularity** — the engine forwards **provider-native deltas** as they arrive (no
   re-chunking); a consumer coalesces for its transport (e.g. the Slack renderer debounces edits to
   ~1/s). Tool calls surface only as finalized `action.requested` in v0; `tool_call.delta` (streaming
   args) is deferred (purely additive later). *Rationale*: keep the core dumb/cheap; `done.reply` is
   the authoritative source, so partial-arg streaming has low value now.
2. **Suspend concurrency** — **one pending `requestInput` at a time** (a turn may suspend/resume many
   times, sequentially). This falls out of the sequential tool loop (`for (call of toolCalls) await
   toolStep`); concurrent suspends would require parallel tool execution — a separate, larger change.
3. **Resume authorization** — **default binds the answerer to the trigger user id**; `requestInput`
   may pass a `canAnswer(user)` predicate to widen (e.g. a manager approves, not the requester). The
   framework feeds the *verified* resumer identity (from the channel's signed event) to the predicate;
   the app may consult `ctx.services` for roles.
4. **Delta persistence** — **live-only, no durable delta storage**. A subscriber reconnecting to a
   still-live turn receives one *current-draft snapshot* from the engine's in-memory accumulation, then
   live deltas; a non-live (evicted) turn re-runs and streams fresh. A ring buffer is deferred.
5. **`turn(): Promise<string>` sugar** — **kept as an explicitly non-interactive convenience** (throws
   if the turn suspends), documented for CLI/tests/simple cases. The primary interface is
   `start` + `observe` + `result(turnId): Promise<TurnResult>`; anyone building a channel uses those, so
   the sugar can't hide streaming.
6. **Proactive seed** — **a distinct `trigger`-role Msg in the durable log** (honest transcript /
   attribution), **mapped to a user/system message at the model adapter** (providers needn't support a
   new role) — reusing the system-overlay pattern. Lighter alternative (an optional `trigger` field on
   a user Msg) rejected for weaker semantic separation. **Lands in P4** — P1a does not add a `trigger`
   role to the `Msg` union; `turn.started`'s trigger is derived live from the inbound event and is not
   persisted.
7. **Subagent events** — **reference, not flatten**. A subagent is a tool, so the parent stream carries
   its `action.requested`/`action.completed` with the child `turnId`; drilling in = subscribing to the
   child's own stream. Automatic cross-DO forwarding is deferred (opt-in later).
```
