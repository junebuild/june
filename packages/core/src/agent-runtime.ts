// agent-runtime.ts — the durable turn engine and its seams.
//
// A pure contract layer (zero node:*): the engine depends ONLY on three seams —
// SessionStore, Broadcaster, Model. No SQLite, no HTTP, no platform. The SAME
// code runs over the native seam (@junejs/server's agent-native, on the host
// SQLite driver) and, later, over a Cloudflare Durable Object. It is the sibling
// of agent.ts (the defineAction registry the runtime consumes), not a
// replacement.
//
// Durability model (log-replay + step-checkpoint):
//   • the `messages` log IS the session state — a fresh process rebuilds the loop
//     position purely from the log, so resume is automatic.
//   • modelStep/toolStep memoize into a `steps` table; a completed step is skipped
//     on replay. The checkpoint key ALWAYS carries the session dimension (the
//     SessionStore is session-scoped) so keys cannot leak across sessions.

import type { Principal } from "./context";

// ── domain ──────────────────────────────────────────────────────────────────

// The server↔core contract counter (#94). @junejs/server asserts this at surface
// construction (AgentDurableObject / NativeRuntime) against the number IT was built
// for — so when a package manager nests a second, older core copy under server
// (regular-dep version skew), the mismatch fails at POWER-ON with both versions
// named, instead of mid-turn with something like "sink.emit is not a function".
// Bump ONLY when the server↔core runtime contract changes shape (a seam signature,
// an event/store type the server constructs against) — not on every release.
export const RUNTIME_API_VERSION = 1;

// `providerState` (#92) is OPAQUE round-trip state a model adapter may attach to a
// tool call: some providers require it replayed verbatim (Gemini 3+ returns a
// thoughtSignature per functionCall and rejects replays that omit it). Contract:
// written by the adapter when it builds the reply, stored on the assistant Msg with
// the rest of the call, and handed back UNTOUCHED when the transcript replays to the
// adapter — the engine never reads it, and it is never part of identity (step keys
// and dispatch use `id` alone). Without this field, adapters smuggle the state
// inside `id` — leaking it into every ledger keyed by callId and breaking on any
// id normalization.
export type ToolCall = { id: string; name: string; input: unknown; providerState?: string };
export type Msg =
  | { role: "user"; turnId: string; text: string }
  // A proactive turn's opening message (§9): a schedule / another channel / the agent itself
  // seeded this turn (no inbound user). A DISTINCT role — not a user Msg — so the durable
  // transcript honestly attributes who initiated it (`by`); the model adapter maps it to a
  // user/system message (providers needn't support a new role). See RFC decision #6.
  | { role: "trigger"; turnId: string; text: string; by: string }
  | { role: "assistant"; turnId: string; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; turnId: string; toolCallId: string; name: string; result: unknown };
export type ModelReply = { text: string; toolCalls: ToolCall[] };
export type ToolSpec = { name: string; description: string; input: unknown };

// A normalized inbound event — the platform-agnostic envelope a turn was triggered
// by. Defined at this (lowest) layer because ToolContext carries it: a channel's
// capability tool (e.g. slack_read_thread) defaults its target — channel / thread /
// message ts — from the CURRENT turn's event, so the model can call it with no args.
// A channel adapter maps its native payload (Slack Events API, Crisp hook, …) into
// this one shape; agent-config and channels re-export it for adapter authors.
//
// `kind` distinguishes a user message from a reaction (emoji) or an edit, so a
// channel subscribing to reaction_added/removed can route those as turns too — `text`
// is present for message/app_mention, `reaction` for the emoji events. `raw` is the
// untouched platform payload: an escape hatch for anything not yet normalized.
export type InboundEvent = {
  source: string;                               // the channel that produced it ("slack" / "crisp")
  kind: "message" | "app_mention" | "reaction_added" | "reaction_removed" | "message_changed" | "rating" | "state_changed";
  channelId: string;                            // the conversation container: slack channel id / crisp website id
  threadId?: string;                            // thread within it: slack thread_ts / crisp conversation session id
  teamId?: string;                              // workspace/tenant the event belongs to (slack team_id) —
                                                // chat.startStream needs it as recipient_team_id in channels
  ts: string;                                   // this event's message ts
  user?: { id: string; name?: string };         // WHO the platform CLAIMS is speaking (untrusted)
  // WHO the app VERIFIED is speaking — resolved by a channel identity seam (e.g.
  // crispChannel's resolveIdentity) from platform-verified evidence, never from the
  // payload alone. The same Principal the UI/MCP paths carry (ActionContext.user), so
  // one authorization model spans every dispatch path. Must be JSON-serializable: it
  // rides the event across the /turn RPC and survives a suspend checkpoint (`raw` is
  // stripped there; principal is kept). Absent = anonymous turn (see Tool.requiresPrincipal).
  principal?: Principal;
  text?: string;                                // message / app_mention carry text; reactions don't
  reaction?: { name: string; itemTs: string };  // WHICH emoji, on WHICH message
  rating?: { stars: number; comment?: string }; // rating events: the score the visitor left (CSAT)
  state?: string;                               // state_changed events: the new conversation state (e.g. "resolved")
  raw?: unknown;                                // untouched platform payload (escape hatch); may
                                                // be dropped crossing the /turn RPC if unserializable
};

// The Model seam — provider-agnostic and STREAMING-FIRST. A model yields a stream of
// deltas as it produces them; a non-streaming provider is the degenerate case (a stream
// of length 1: just `done`). `reasoning`/`text` are live tokens the engine forwards as
// TurnEvents; `done` carries the authoritative assembled ModelReply the engine checkpoints
// (the adapter owns assembly, so the engine never re-derives tool calls from partial text).
// `opts.system` is the per-turn system prompt, injected by the runtime (see withSystem).
// WHY generation stopped, normalized across providers. Every provider ships its own
// vocabulary for this — Anthropic's Messages API `stop_reason` (end_turn / max_tokens /
// stop_sequence / tool_use / pause_turn / refusal / model_context_window_exceeded, per
// @anthropic-ai/sdk ≥0.60's Message type) and Gemini's `candidates[].finishReason`
// (STOP / MAX_TOKENS / SAFETY / RECITATION / MALFORMED_FUNCTION_CALL / …, per
// ai.google.dev/api/generate-content#FinishReason) — and both document that an abnormal
// stop may come with EMPTY content. An adapter that ignores the field converts a
// truncated/filtered response into a graceful empty reply, which the engine then
// "completes" silently (the production failure mode this type exists to kill). `raw`
// preserves the provider's own value for diagnostics.
export type ModelFinish = {
  reason: "stop" | "max_tokens" | "content_filter" | "malformed_tool_call" | "refusal" | "other";
  raw?: string;
};

export type ModelDelta =
  | { type: "reasoning"; text: string }   // thinking tokens (when the provider streams them)
  | { type: "text"; text: string }        // answer tokens
  | { type: "done"; reply: ModelReply; finish?: ModelFinish };  // terminal: the full assembled reply + why it stopped
export type Model = (msgs: Msg[], tools: ToolSpec[], opts?: { system?: string }) => AsyncIterable<ModelDelta>;

// A one-shot model output: a single-element stream. The degenerate streaming case, for
// scripted/test models and providers without token streaming.
export function replyStream(reply: ModelReply, finish?: ModelFinish): AsyncIterable<ModelDelta> {
  // Spread, don't assign: a no-claim call must not add an own `finish: undefined` property —
  // the pre-finish delta shape stays byte-identical for presence checks and deep equality.
  return (async function* () { yield { type: "done", reply, ...(finish ? { finish } : {}) }; })();
}

// Wrap a Model so every call carries `system` (the agent's instructions). The
// runtime applies this from the agent def, so a provider model needn't bake the
// system prompt in at construction — one model instance can serve many agents,
// each supplying its own system per turn. A per-turn `opts.system` (e.g. a channel
// instruction overlay derived from the inbound event's source) is APPENDED to the
// base, not dropped — so the base instructions and the per-turn overlay compose.
export function withSystem(model: Model, system: string): Model {
  return (msgs, tools, opts) => model(msgs, tools, { ...opts, system: [system, opts?.system].filter(Boolean).join("\n\n") });
}

// A tool's `run` gets a context: its session-local `store` (write app state in
// the SAME tx as the checkpoint → exactly-once), and the `runtime` so a tool can
// spawn a child session — that is how a SUBAGENT works (a tool that runs a child
// actor). `run` is sync for local tools, async for remote ones (incl. subagents).
export interface ToolContext {
  store: SessionStore;
  runtime: Runtime;
  agent: string;
  sessionId: string;
  callId: string;
  // The inbound event that triggered this turn (when the turn came from a channel
  // that supplies one). A channel capability tool reads it to default its target —
  // e.g. slack_read_thread with no args reads ctx.event.threadId. Undefined for turns
  // not driven by a channel envelope (a bare /message POST, a scripted test).
  event?: InboundEvent;
  // The turn's resolved TRUSTED identity — a convenience mirror of event.principal
  // (see InboundEvent). A tool that reads tenant/user-scoped data keys its queries and
  // credentials off THIS, never off model-supplied input or event.user: the model
  // cannot influence it, so a prompt injection cannot steer a tool across tenants.
  principal?: Principal;
  // WHO OPENED this session (#128): the first resolved principal any turn arrived with,
  // recorded durably and immutable thereafter — in a multi-participant thread this lets
  // a tool tell the session's opener (initiator) apart from the current turn's speaker
  // (principal), e.g. only the initiator may widen a query's scope.
  // Deliberately NOT part of the requiresPrincipal gate: tool visibility keys off the
  // CURRENT speaker, so an anonymous follow-up in an operator-opened session does not
  // inherit the operator's tools. Undefined until some turn resolves a principal.
  initiator?: Principal;
  // Ask for external (human) input and SUSPEND the turn until session.resume provides it.
  // First call throws SuspendSignal to park the turn (durably); on the replay after resume it
  // returns the stored answer. Only usable from an ASYNC tool — a sync (local) tool commits in
  // the same tx and cannot park, so calling it there throws a plain Error (the turn fails
  // loudly). `answererId` defaults to the trigger user (ctx.event.user.id).
  requestInput(req: { id: string; prompt: string; schema?: unknown; answererId?: string }): Promise<unknown>;
}
export type Tool = {
  spec: ToolSpec;
  run: (input: any, ctx: ToolContext) => unknown;
  subagent?: boolean;
  // Principal gate: when true, the tool exists only on turns with a resolved trusted
  // identity (event.principal) — on an anonymous turn it is dropped from the model's
  // tool list entirely, so the model can neither call it nor see it. Mark every tool
  // that reads user/tenant-scoped data; leave knowledge/utility tools unmarked.
  requiresPrincipal?: boolean;
};

// ── the two inner seams (LOCAL, per-session, co-located with execution) ───────
//
// A SessionStore instance is ALREADY scoped to one session — there is no
// session_id parameter anywhere. That is the structural fix for cross-session
// step-id collision: sessions cannot share checkpoint keys because they don't
// share a store. `tx` is a SYNCHRONOUS transaction: the durability contract
// (side effect + checkpoint + message append committing atomically) requires it.
export interface SessionStore {
  appendMessage(m: Msg): void;
  messages(): Msg[];
  // Has this turn's OPENING message already been appended? (a user msg for an inbound turn,
  // a trigger msg for a proactive one.) Guards against double-seeding on a crash-replay.
  hasOpeningMessage(turnId: string): boolean;
  getStep(id: string): unknown | undefined;
  putStep(id: string, output: unknown): void;
  delStep(id: string): void; // remove a checkpoint (a consumed suspend park); no-op when absent
  getStatus(): string;
  setStatus(s: string): void;
  tx<T>(fn: () => T): T; // synchronous transaction
  // Escape hatch to the underlying storage handle, so a local tool can write its
  // own app table inside `tx` (exactly-once). On native this is the host sync
  // SQLite handle; on an edge target it is ctx.storage.sql.
  unwrap<H = unknown>(): H;
}

// ── the turn as a live event stream (see docs/rfc-turn-as-live-process.md) ────
// A turn emits a stream of typed events as it runs. In THIS slice (P1a) events are LIVE:
// emitted during a fresh execution and observed via AgentSession.observe. There is NOT yet
// a replay/catch-up path — on a crash-replay a cached step short-circuits WITHOUT
// re-emitting, so a subscriber that attaches mid-turn misses the prior events; and
// turn.started's `trigger` + turn.failed are live-only (not persisted in the message/step
// log). The RFC's target splits events into structural (foldable from the log) vs live
// *.delta and adds a fold-on-reconnect catch-up — that durable story lands in P1b (SSE +
// observe replay), not here. P1a emits the structural set (turn.started, action.requested/
// completed, message.completed, turn.completed/failed); reasoning.delta/message.delta arrive
// with the streaming Model (P2); input.requested with suspend/resume (P3).
// A tool's request for external (human) input that suspends the turn. `id` keys the answer
// (stable within the turn). `answererId` is who may answer — defaults to the turn's trigger
// user; the app widens it (e.g. a manager approves) by passing one to ctx.requestInput.
// Serializable (it rides input.requested over SSE and persists in the suspended checkpoint).
export type InputRequest = { id: string; prompt: string; schema?: unknown; answererId?: string };

// Thrown by ctx.requestInput to PARK a turn awaiting input. The engine catches it, persists
// the pending request as a checkpoint, and reports { status: "suspended" }. A later
// session.resume stores the answer and replays — the same durable step-checkpoint machine that
// gives exactly-once, now: "a step whose result comes from a human instead of a tool".
export class SuspendSignal extends Error {
  readonly request: InputRequest;
  readonly callId: string; // the tool call that parked the turn
  constructor(request: InputRequest, callId: string) {
    super(`turn suspended awaiting input: ${request.id}`);
    this.request = request;
    this.callId = callId;
  }
}

// Thrown by AgentSession.resume when the resumer may not answer the pending request.
// A distinct class so a transport (the DO's /resume) can map it to 403 vs 409.
export class ResumeAuthorizationError extends Error {}

// What the engine persists under the `suspended` step when a turn parks: enough to
// validate a later resume (turnId, the pending request) and replay the turn (userText/
// overlay/event). One per session — turns serialize, and start() rejects new turns while
// one is parked, so a single fixed key cannot be clobbered.
type SuspendedCheckpoint = { turnId: string; callId: string; request: InputRequest; userText: string; systemOverlay?: string; event?: InboundEvent };
// The proactive variant stands alone: it's the only trigger a CALLER may pass explicitly
// (TurnInput / ChannelContext.run / receive()) — inbound is derived from the event, resume is
// engine-internal. Narrowing the public seams to this type makes misuse (passing an inbound or
// resume trigger to the proactive entrypoint) unrepresentable, and keeps the /turn wire payload
// trivially JSON-serializable (no embedded event.raw).
export type ProactiveTrigger = { kind: "proactive"; by: string; note?: string }; // a schedule, another channel, the agent itself
export type TurnTrigger =
  | { kind: "inbound"; event: InboundEvent }          // a channel event (message, mention, reaction)
  | ProactiveTrigger
  | { kind: "resume"; callId: string };                // continuation after an input.requested suspend
export type TurnEvent =
  | { type: "turn.started"; turnId: string; trigger: TurnTrigger }
  | { type: "action.requested"; turnId: string; call: ToolCall }
  | { type: "action.completed"; turnId: string; call: ToolCall; result: unknown }
  | { type: "message.completed"; turnId: string; text: string }
  | { type: "input.requested"; turnId: string; request: InputRequest }
  | { type: "turn.completed"; turnId: string; text: string }
  | { type: "turn.failed"; turnId: string; error: TurnError; phase?: TurnFailurePhase; step?: string }
  | { type: "reasoning.delta"; turnId: string; text: string }
  | { type: "message.delta"; turnId: string; text: string };
export type TurnResult =
  | { status: "completed"; text: string }
  | { status: "suspended"; request: InputRequest }
  | { status: "failed"; error: TurnError };

// A turn failure, serialized AT THE THROW SITE — the one place the real Error still
// exists. Everything downstream of the event sink (SSE across the worker→DO isolate,
// onTurnError, a channel render) sees only this shape, so whatever isn't captured here
// is gone: for a detached turn this is the ONLY failure-surfacing path (#96).
// `causeChain` walks `error.cause` outermost-first (messages only — one stack is
// enough to locate the site, the chain explains why).
export type TurnError = { message: string; stack?: string; causeChain?: string[] };
// Which engine step was in flight when the turn died — turns "fetch failed" into
// "the model call failed" vs "tool tool:call_7 failed". `step` on turn.failed carries
// the precise step id (`model:<n>` / `tool:<callId>`). Absent when the failure struck
// between steps (transcript reads, status writes).
export type TurnFailurePhase = "model" | "tool";

export function serializeTurnError(err: unknown): TurnError {
  if (err instanceof Error) {
    const causeChain: string[] = [];
    // depth-capped: a cyclic cause chain (err.cause === err) must not spin forever
    for (let c: unknown = err.cause, depth = 0; c !== undefined && depth < 8; depth++) {
      causeChain.push(c instanceof Error ? c.message : stringifyThrown(c));
      c = c instanceof Error ? c.cause : undefined;
    }
    return { message: err.message, ...(err.stack ? { stack: err.stack } : {}), ...(causeChain.length ? { causeChain } : {}) };
  }
  return { message: stringifyThrown(err) };
}
// Non-Error throwables keep their JSON shape instead of collapsing to "[object Object]".
function stringifyThrown(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    if (s !== undefined) return s;
  } catch { /* cyclic or hostile toJSON — fall through */ }
  return String(v);
}

// The event bus a turn emits to; observers (channels, an SSE surface) subscribe. Replaces
// the old coarse `Broadcaster.publish(turnId)` poke with typed events.
export interface EventSink {
  emit(e: TurnEvent): void;
  subscribe(cb: (e: TurnEvent) => void): () => void;
}

// Crash injection for the durability contract: throw at a chosen checkpoint
// boundary so a test can assert exactly-once across a real replay. Opt-in via
// `opts.crash`; absent in every production turn. Kept in the engine so the
// guarantee stays verifiable against the SAME code that ships.
export type Crash = {
  at: "before-model-commit" | "after-model-commit" | "before-tool-commit" | "after-tool-commit";
  step: string;
};

function assertCrash(crash: Crash | undefined, at: Crash["at"], step: string) {
  if (crash && crash.at === at && crash.step === step) throw new Error(`CRASH ${at} ${step}`);
}

// ── the engine: one durable turn ──────────────────────────────────────────────
// Reserved step key for the session's initiator principal (#128). It lives in the steps
// table beside the "suspended" checkpoint and the per-turn step ids ("model:N",
// "tool:<id>", "input:<turn>:<id>") — a namespace no turn-scoped key can collide with —
// so recording it needs no SessionStore contract change and it survives eviction with
// the rest of the durable log.
const INITIATOR_STEP = "session:initiator";

export async function runTurn(
  store: SessionStore,
  sink: EventSink,
  model: Model,
  tools: Tool[],
  opts: { turnId: string; userText: string; crash?: Crash },
  env: { runtime: Runtime; agent: string; sessionId: string; event?: InboundEvent; systemOverlay?: string; trigger?: TurnTrigger },
): Promise<string> {
  // env.trigger overrides the derivation: a resume continuation announces { kind: "resume" }
  // even though it replays with the original inbound event.
  const trigger: TurnTrigger = env.trigger ?? (env.event ? { kind: "inbound", event: env.event } : { kind: "proactive", by: "system" });
  if (!store.hasOpeningMessage(opts.turnId)) {
    // An EXPLICITLY proactive turn (receive() / a schedule / another channel passed
    // env.trigger) opens with a `trigger` msg attributing who seeded it. A plain programmatic
    // turn (no event, no explicit trigger — CLI/http) is derived proactive/system for the live
    // turn.started event, but its opening stays a `user` msg: it's an API caller, not an
    // attributed agent-initiated seed. So key the role off the EXPLICIT trigger. See RFC §9 / #6.
    const opening: Msg = env.trigger?.kind === "proactive"
      ? { role: "trigger", turnId: opts.turnId, text: opts.userText, by: env.trigger.by }
      : { role: "user", turnId: opts.turnId, text: opts.userText };
    store.tx(() => store.appendMessage(opening));
  }
  // Durable session identity (#128): the FIRST resolved principal any turn arrives with
  // becomes the session's initiator — recorded once under a reserved step key (so the
  // SessionStore contract stays untouched and it survives eviction with the rest of the
  // log), immutable thereafter. The tx guard mirrors the suspend checkpoint's: a
  // crash-replay or a raced duplicate must not double-INSERT the step.
  let initiator = store.getStep(INITIATOR_STEP) as Principal | undefined;
  if (initiator === undefined && env.event?.principal != null) {
    const principal = env.event.principal;
    store.tx(() => {
      if (store.getStep(INITIATOR_STEP) === undefined) store.putStep(INITIATOR_STEP, principal);
    });
    initiator = principal;
  }
  store.setStatus("running");
  sink.emit({ type: "turn.started", turnId: opts.turnId, trigger });

  // Principal gate: on a turn without a resolved trusted identity, requiresPrincipal
  // tools are absent by construction — not listed to the model, not resolvable by
  // toolStep (a hallucinated call fails loudly as an unknown tool). Filtered per-turn
  // (not at registration) because the same agent serves identified and anonymous
  // conversations; the filter is stable across a crash-replay since the principal
  // rides the persisted event.
  const active = env.event?.principal != null ? tools : tools.filter((t) => !t.requiresPrincipal);
  const specs = active.map((t) => t.spec);
  // Which durable step is in flight, for turn.failed attribution: set before each step
  // await, cleared on its return, so a throw OUTSIDE a step (transcript read, status
  // write) isn't blamed on the previously completed one.
  let inFlight: { phase: TurnFailurePhase; step: string } | undefined;
  try {
    while (true) {
      const msgs = store.messages();
      // Non-null: the loop always runs with ≥1 message (the user turn is appended
      // above before the first iteration), so the transcript is never empty here.
      const last = msgs[msgs.length - 1]!;

      if (last.role === "assistant" && last.toolCalls.length === 0) {
        store.setStatus("done");
        sink.emit({ type: "turn.completed", turnId: opts.turnId, text: last.text });
        return last.text;
      }
      if (last.role === "assistant" && last.toolCalls.length > 0) {
        for (const call of last.toolCalls) {
          inFlight = { phase: "tool", step: `tool:${call.id}` };
          await toolStep(store, sink, active, call, opts, { ...env, initiator });
          inFlight = undefined;
        }
        continue;
      }
      inFlight = { phase: "model", step: `model:${msgs.length}` };
      await modelStep(store, sink, model, specs, `model:${msgs.length}`, msgs, opts, env.systemOverlay);
      inFlight = undefined;
    }
  } catch (err) {
    if (err instanceof SuspendSignal) {
      // park the turn: persist everything a later resume needs to validate + replay (the pending
      // request + the turn's userText/overlay/event), mark suspended, and announce input.requested.
      // raw is stripped so the checkpoint stays JSON-serializable on the edge. Guarded put: a
      // redelivered replay of an already-parked turn re-announces WITHOUT re-inserting (putStep
      // is insert-only on the SQL stores).
      const event = env.event ? { ...env.event, raw: undefined } : undefined;
      const checkpoint: SuspendedCheckpoint = { turnId: opts.turnId, callId: err.callId, request: err.request, userText: opts.userText, systemOverlay: env.systemOverlay, event };
      store.tx(() => {
        if (store.getStep("suspended") === undefined) store.putStep("suspended", checkpoint);
        store.setStatus("suspended");
      });
      sink.emit({ type: "input.requested", turnId: opts.turnId, request: err.request });
      throw err; // AgentSession.result maps this to { status: "suspended" }
    }
    // includes intentional crash-injection throws (a failed ATTEMPT; replay re-runs).
    sink.emit({ type: "turn.failed", turnId: opts.turnId, error: serializeTurnError(err), phase: inFlight?.phase, step: inFlight?.step });
    throw err;
  }
}

async function modelStep(
  store: SessionStore,
  sink: EventSink,
  model: Model,
  specs: ToolSpec[],
  stepId: string,
  msgs: Msg[],
  opts: { turnId: string; crash?: Crash },
  systemOverlay?: string,
) {
  if (store.getStep(stepId) !== undefined) return; // cached: assistant already appended in the same tx
  // Iterate the model stream: forward reasoning/answer tokens as LIVE TurnEvents (not
  // persisted, not re-emitted on replay), and take the terminal `done.reply` as the value
  // to checkpoint. The adapter's `done` is authoritative — the engine never assembles the
  // reply from partial text/tool deltas.
  let reply: ModelReply | undefined;
  let finish: ModelFinish | undefined;
  for await (const d of model(msgs, specs, systemOverlay ? { system: systemOverlay } : undefined)) {
    if (d.type === "reasoning") sink.emit({ type: "reasoning.delta", turnId: opts.turnId, text: d.text });
    else if (d.type === "text") sink.emit({ type: "message.delta", turnId: opts.turnId, text: d.text });
    else { reply = d.reply; finish = d.finish; break; } // `done` is terminal: `break` cancels the iterator (return()) so
    // extra deltas / a throw AFTER the authoritative reply can't turn a completed turn into a failure
  }
  if (!reply) throw new Error("model stream ended without a `done` event");
  // An ABNORMAL stop with an EMPTY reply fails the step instead of committing: providers
  // signal truncation/filtering via the finish reason, and both major APIs document that
  // such stops may carry no content at all. Committing "" here would let the turn
  // "complete" silently — a channel then renders nothing and nobody is told why. A reply
  // WITH content under an abnormal reason still commits (truncated-but-usable), and an
  // adapter that reports no finish keeps today's behavior — an empty completion stays
  // legitimate where it is deliberate (tool-only turns end with empty text by design).
  // Thrown BEFORE the checkpoint, so a retry re-runs the model like any model failure.
  if (finish && finish.reason !== "stop" && !reply.text.trim() && reply.toolCalls.length === 0) {
    const detail = finish.raw && finish.raw !== finish.reason ? ` (provider: ${finish.raw})` : "";
    throw new Error(`model stopped abnormally — ${finish.reason}${detail} — and returned an empty reply`);
  }
  assertCrash(opts.crash, "before-model-commit", stepId); // nothing persisted → replay re-asks the model
  store.tx(() => {
    store.putStep(stepId, reply);
    store.appendMessage({ role: "assistant", turnId: opts.turnId, text: reply.text, toolCalls: reply.toolCalls });
  });
  assertCrash(opts.crash, "after-model-commit", stepId); // committed → replay skips (exactly-once append)
  // an assistant message finalized (text when present) + one action.requested per tool call
  if (reply.text.trim()) sink.emit({ type: "message.completed", turnId: opts.turnId, text: reply.text });
  for (const call of reply.toolCalls) sink.emit({ type: "action.requested", turnId: opts.turnId, call });
}

async function toolStep(
  store: SessionStore,
  sink: EventSink,
  tools: Tool[],
  call: ToolCall,
  opts: { turnId: string; crash?: Crash },
  env: { runtime: Runtime; agent: string; sessionId: string; event?: InboundEvent; initiator?: Principal },
) {
  const stepId = `tool:${call.id}`;
  if (store.getStep(stepId) !== undefined) return;
  const tool = tools.find((t) => t.spec.name === call.name);
  if (!tool) throw new Error(`unknown tool ${call.name}`);
  const remote = tool.run.constructor.name === "AsyncFunction";
  const ctx: ToolContext = {
    store, runtime: env.runtime, agent: env.agent, sessionId: env.sessionId, callId: call.id, event: env.event, principal: env.event?.principal, initiator: env.initiator,
    // replay-aware: return the stored answer if resume already provided it, else park the turn.
    // Answers are TURN-scoped (`input:${turnId}:${id}`): a later turn re-asking the same id must
    // park again — never silently reuse a prior turn's answer (an approval must not carry over).
    // Deliberately NOT an async function: a sync (local) tool that misuses it must fail loudly
    // and synchronously — an async requestInput would hand it a rejected Promise it can't await,
    // which the local-tool tx would then commit as its checkpointed result.
    requestInput: (req) => {
      if (!remote) throw new Error(`requestInput: tool "${call.name}" runs sync (local) — only an async tool can park the turn awaiting input`);
      const answer = store.getStep(`input:${opts.turnId}:${req.id}`);
      if (answer !== undefined) return Promise.resolve((answer as { input: unknown }).input);
      throw new SuspendSignal({ id: req.id, prompt: req.prompt, schema: req.schema, answererId: req.answererId ?? env.event?.user?.id }, call.id);
    },
  };

  assertCrash(opts.crash, "before-tool-commit", stepId); // nothing done → safe clean re-run
  const toolMsg = (result: unknown): Msg => ({ role: "tool", turnId: opts.turnId, toolCallId: call.id, name: call.name, result });

  let out: unknown;
  if (remote) {
    // network / subagent side effect: at-least-once (can't 2PC with local storage;
    // a subagent is itself durable, and its child turnId makes replay idempotent)
    out = await tool.run(call.input, ctx);
    store.tx(() => { store.putStep(stepId, out); store.appendMessage(toolMsg(out)); });
  } else {
    // local side effect: exactly-once (side effect + checkpoint + append in ONE tx)
    store.tx(() => {
      out = tool.run(call.input, ctx);
      store.putStep(stepId, out);
      store.appendMessage(toolMsg(out));
    });
  }
  assertCrash(opts.crash, "after-tool-commit", stepId); // committed → replay skips (no duplicate side effect)
  sink.emit({ type: "action.completed", turnId: opts.turnId, call, result: out });
}

// ── transcript fold (pure; used by observe/transcript surfaces) ───────────────
export type Turn = {
  turnId: string;
  user: string;
  by?: string; // set when the turn was agent-initiated: who seeded it (the trigger msg's `by`)
  steps: { name: string; done: boolean; result?: unknown }[];
  text?: string;
};
export function foldTranscript(msgs: Msg[]): Turn[] {
  const byId = new Map<string, Turn>();
  const order: string[] = [];
  for (const m of msgs) {
    let t = byId.get(m.turnId);
    if (!t) { t = { turnId: m.turnId, user: "", steps: [] }; byId.set(m.turnId, t); order.push(m.turnId); }
    if (m.role === "user") t.user = m.text;
    else if (m.role === "trigger") { t.user = m.text; t.by = m.by; } // proactive seed shows as the turn's prompt, still attributed
    else if (m.role === "assistant") {
      for (const tc of m.toolCalls) t.steps.push({ name: tc.name, done: false });
      if (m.text) t.text = m.text;
    } else if (m.role === "tool") {
      const s = t.steps.find((x) => x.name === m.name && !x.done) ?? t.steps[t.steps.length - 1];
      if (s) { s.done = true; s.result = m.result; }
    }
  }
  return order.map((id) => byId.get(id)!);
}

// ── turn id minting (#95) ─────────────────────────────────────────────────────
// Globally unique, lexically time-sortable: `t_` + a monotonic ULID (48-bit ms
// timestamp + 80-bit randomness, Crockford base32). Replaces the per-actor
// sequence (`t1`, `t2`, …), which collided in BOTH dimensions: across sessions
// (every session's first turn was "t1" — useless in any table keyed by turnId),
// and within one session across a DO hibernation (the in-memory seq reset to 0,
// re-minting "t1" — which hasOpeningMessage then treated as a REDELIVERY of the
// old turn, silently replaying its steps instead of starting a new turn).
// The `t_` prefix keeps a mixed ledger ordered across the migration boundary:
// every legacy id ("t" + digits — "t1", "t42", …) sorts before every new id
// ("t_01…"), because the character after "t" decides: any digit "0"–"9" < "_".
// Monotonic within one isolate: same-ms mints increment the random block, so a
// ledger ordered by id stays insertion-ordered even inside a burst.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford
let lastMs = -1;
const lastRand = new Uint8Array(10);
export function mintTurnId(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    crypto.getRandomValues(lastRand);
  } else {
    // same (or clock-regressed) ms: +1 with carry keeps ids strictly increasing
    let i = 9;
    for (; i >= 0; i--) { if (++lastRand[i]! <= 0xff) break; lastRand[i] = 0; }
    // full 80-bit rollover (a random start adjacent to the max, or a clock stuck
    // behind): borrow into the time block so the invariant stays absolute
    if (i < 0) lastMs++;
  }
  let time = "";
  for (let ms = lastMs, i = 0; i < 10; i++) { time = B32[ms % 32]! + time; ms = Math.floor(ms / 32); }
  let rand = "";
  for (let i = 0; i < 10; i += 5) {
    // 5 bytes → 8 base32 chars, MSB-first
    let acc = 0;
    for (let j = 0; j < 5; j++) acc = acc * 256 + lastRand[i + j]!;
    let block = "";
    for (let j = 0; j < 8; j++) { block = B32[acc % 32]! + block; acc = Math.floor(acc / 32); }
    rand += block;
  }
  return `t_${time}${rand}`;
}

// ── the outer seam: AgentSession actor (serializes turns via an inbox) ─────────
// `trigger` marks an agent-INITIATED turn (proactive): no inbound event, the turn opens with a
// `trigger`-role seed attributed to `by` (a schedule, another channel, the agent). Omitted for a
// normal inbound/programmatic turn. Proactive-only by type: inbound is derived from `event`,
// resume is engine-internal. See §9 / receive().
export type TurnInput = { turnId?: string; userText: string; crash?: Crash; event?: InboundEvent; trigger?: ProactiveTrigger };

export class AgentSession {
  private chain: Promise<unknown> = Promise.resolve();
  // Per-turn terminal promise, so result(turnId) can await a turn started with start().
  private readonly running = new Map<string, Promise<string>>();
  // Explicit fields + assignment (not constructor parameter properties): June
  // ships raw .ts, so consumers type-strip it — parameter properties aren't
  // erasable and break `erasableSyntaxOnly` / Node native strip-types.
  private readonly agent: string;
  private readonly id: string;
  private readonly store: SessionStore;
  private readonly sink: EventSink;
  private readonly model: Model;
  private readonly tools: Tool[];
  private readonly runtime: Runtime;
  // Per-source system overlays: when a turn's InboundEvent.source matches a key, that
  // text is appended to the system prompt for the turn (see withSystem). Lets ONE shared
  // agent branch its behavior by real, unforgeable channel source — no userText markers.
  private readonly channelInstructions?: Record<string, string>;
  constructor(agent: string, id: string, store: SessionStore, sink: EventSink, model: Model, tools: Tool[], runtime: Runtime, channelInstructions?: Record<string, string>) {
    this.agent = agent;
    this.id = id;
    this.store = store;
    this.sink = sink;
    this.model = model;
    this.tools = tools;
    this.runtime = runtime;
    this.channelInstructions = channelInstructions;
  }

  // Kick a turn off WITHOUT awaiting it — returns its id so a caller can `observe` the
  // live event stream and `result(turnId)` for the terminal state. This is the primary
  // interface for live/streaming consumers (channels, SSE). Turns are serialized: each
  // awaits the previous on the chain — no interleaving on the shared transcript. (On a
  // Durable Object this is blockConcurrencyWhile; here it's a promise chain.)
  start(input: TurnInput): { turnId: string } {
    const turnId = input.turnId ?? mintTurnId();
    // While a turn is parked awaiting input, the transcript ends in its dangling tool call —
    // running a NEW turn on it would corrupt both (the resumed replay would adopt the new
    // turn's tail as its own result). Reject loudly; redelivering the SAME parked turn is
    // allowed (it replays, re-parks, and re-announces input.requested).
    if (this.store.getStatus() === "suspended") {
      const s = this.store.getStep("suspended") as SuspendedCheckpoint | undefined;
      if (s && s.turnId !== turnId) {
        throw new Error(`session is suspended awaiting input "${s.request.id}" (turn ${s.turnId}); resume it before starting a new turn`);
      }
    }
    const systemOverlay = input.event ? this.channelInstructions?.[input.event.source] : undefined;
    const run = () =>
      runTurn(
        this.store,
        this.sink,
        this.model,
        this.tools,
        { turnId, userText: input.userText, crash: input.crash },
        { runtime: this.runtime, agent: this.agent, sessionId: this.id, event: input.event, systemOverlay, trigger: input.trigger },
      );
    this.track(turnId, this.chain.then(run));
    return { turnId };
  }

  // Register the in-flight promise for result() and prune it on settle. The delete is tied to
  // THIS promise's identity: a suspend→resume reuses the same turnId, so the parked promise's
  // late cleanup must NOT clear the continuation's entry (delete by turnId alone would). Both
  // branches run cleanup, so the rejection is handled here — no unhandled rejection.
  private track(turnId: string, p: Promise<string>): void {
    this.chain = p.catch(() => {}); // a failed turn must not break the inbox
    this.running.set(turnId, p);
    const clear = () => { if (this.running.get(turnId) === p) this.running.delete(turnId); };
    p.then(clear, clear);
  }

  // Await a turn's terminal state (completed | suspended | failed). Reads the in-flight promise
  // from start(); if the turn already finished/parked, falls back to the durable log (status +
  // the suspended checkpoint / final assistant text) so a late result() call still resolves.
  async result(turnId: string): Promise<TurnResult> {
    const p = this.running.get(turnId);
    if (p) {
      try { return { status: "completed", text: await p }; }
      catch (err) {
        if (err instanceof SuspendSignal) return { status: "suspended", request: err.request };
        return { status: "failed", error: serializeTurnError(err) };
      }
    }
    if (this.store.getStatus() === "suspended") {
      const s = this.store.getStep("suspended") as SuspendedCheckpoint | undefined;
      if (s && s.turnId === turnId) return { status: "suspended", request: s.request }; // only THIS turn's park
    }
    const msgs = this.store.messages().filter((m) => m.turnId === turnId);
    const lastAssistant = [...msgs].reverse().find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant");
    if (lastAssistant && lastAssistant.toolCalls.length === 0) return { status: "completed", text: lastAssistant.text };
    return { status: "failed", error: { message: `no terminal result for turn ${turnId}` } };
  }

  // Provide the input a suspended turn is waiting on and continue it. Stores the answer as the
  // `input:{turnId}:{inputId}` checkpoint, then replays the turn: cached steps skip,
  // ctx.requestInput now finds its answer and returns, and the turn runs on (may complete, or
  // suspend again). `opts.by` is the resumer's VERIFIED identity — the caller must authenticate
  // it (e.g. the user id from a signed Slack interaction payload), never trust a client-supplied
  // value. When the request names an answererId, resume is DEFAULT-DENY: an absent `by` is an
  // unauthenticated resume and cannot answer. Returns { turnId } like start(); await
  // result(turnId) for the new terminal state.
  resume(turnId: string, inputId: string, input: unknown, opts?: { by?: string }): { turnId: string } {
    const suspended = this.store.getStep("suspended") as SuspendedCheckpoint | undefined;
    if (!suspended || suspended.turnId !== turnId) throw new Error(`turn ${turnId} is not suspended`);
    if (inputId !== suspended.request.id) {
      throw new Error(`turn ${turnId} is awaiting input "${suspended.request.id}", not "${inputId}"`);
    }
    if (suspended.request.answererId && opts?.by !== suspended.request.answererId) {
      throw new ResumeAuthorizationError(`resume: ${opts?.by ?? "<unidentified>"} is not authorized to answer input "${inputId}"`);
    }
    this.store.tx(() => {
      this.store.putStep(`input:${turnId}:${inputId}`, { input });
      this.store.delStep("suspended"); // consumed — the next park (same turn or a later one) inserts cleanly
      this.store.setStatus("running");
    });
    const run = () =>
      runTurn(
        this.store,
        this.sink,
        this.model,
        this.tools,
        { turnId, userText: suspended.userText },
        { runtime: this.runtime, agent: this.agent, sessionId: this.id, event: suspended.event, systemOverlay: suspended.systemOverlay, trigger: { kind: "resume", callId: suspended.callId } },
      );
    this.track(turnId, this.chain.then(run));
    return { turnId };
  }

  // Sugar: run a turn and await its final text. Explicitly the NON-INTERACTIVE convenience
  // (CLI, tests, simple cases) — it throws if the turn fails; use start()+observe()+result()
  // for liveness/interaction.
  turn(input: TurnInput): Promise<string> {
    return this.running.get(this.start(input).turnId)!;
  }

  // Subscribe to this session's TurnEvent stream. Scope to one turn with `turnId`; with
  // `replay`, first emit the structural events foldable from the durable log (message.completed,
  // action.requested/completed, and turn.completed if finished) so a late/reconnecting subscriber
  // catches up, THEN live events. `turn.started`'s trigger + `turn.failed` are live-only (not
  // persisted), so they aren't part of the folded prefix.
  observe(cb: (e: TurnEvent) => void, opts?: { turnId?: string; replay?: boolean }): () => void {
    // Fold-then-subscribe is race-free HERE despite looking like a gap: this method is fully
    // SYNCHRONOUS (store.messages() + cb are sync) and the engine emits synchronously right
    // after each store.tx commit (no await between). Single-threaded JS therefore can't run an
    // engine step between the fold and the subscribe, so no event is missed or duplicated. (A
    // subscribe-first + buffer approach would instead double-deliver any event committed-before-
    // fold-but-emitted-after-subscribe.) If either invariant ever changes, revisit this.
    if (opts?.replay && opts.turnId) for (const e of this.foldEvents(opts.turnId)) cb(e);
    const { turnId } = opts ?? {};
    return this.sink.subscribe(turnId ? (e) => { if (e.turnId === turnId) cb(e); } : cb);
  }

  // Reconstruct the structural TurnEvents for one turn from the message log (the durable
  // counterpart of the live stream). Tool inputs are recovered from the assistant message's
  // tool calls so action.completed carries the full call.
  private foldEvents(turnId: string): TurnEvent[] {
    const msgs = this.store.messages().filter((m) => m.turnId === turnId);
    const inputs = new Map<string, ToolCall>();
    const out: TurnEvent[] = [];
    for (const m of msgs) {
      if (m.role === "assistant") {
        if (m.text.trim()) out.push({ type: "message.completed", turnId, text: m.text });
        for (const call of m.toolCalls) { inputs.set(call.id, call); out.push({ type: "action.requested", turnId, call }); }
      } else if (m.role === "tool") {
        out.push({ type: "action.completed", turnId, call: inputs.get(m.toolCallId) ?? { id: m.toolCallId, name: m.name, input: undefined }, result: m.result });
      }
    }
    // terminal iff the last assistant message has no tool calls — same condition the live
    // engine uses (regardless of whether the final text is empty), so replay and live agree.
    const lastAssistant = [...msgs].reverse().find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant");
    if (lastAssistant && lastAssistant.toolCalls.length === 0)
      out.push({ type: "turn.completed", turnId, text: lastAssistant.text });
    return out;
  }

  transcript(): Turn[] { return foldTranscript(this.store.messages()); }
  snapshot() { return { transcript: this.transcript(), status: this.store.getStatus() }; }
}

// Address space: a runtime resolves a session actor by (agentName, id). Native =
// an in-process map (@junejs/server); edge = idFromName on a DO namespace.
export interface Runtime {
  session(agent: string, id: string): AgentSession;
}
