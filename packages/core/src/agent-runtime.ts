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

// ── domain ──────────────────────────────────────────────────────────────────
export type ToolCall = { id: string; name: string; input: unknown };
export type Msg =
  | { role: "user"; turnId: string; text: string }
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
  kind: "message" | "app_mention" | "reaction_added" | "reaction_removed" | "message_changed";
  channelId: string;                            // the conversation container: slack channel id / crisp website id
  threadId?: string;                            // thread within it: slack thread_ts / crisp conversation session id
  ts: string;                                   // this event's message ts
  user?: { id: string; name?: string };         // WHO
  text?: string;                                // message / app_mention carry text; reactions don't
  reaction?: { name: string; itemTs: string };  // WHICH emoji, on WHICH message
  raw?: unknown;                                // untouched platform payload (escape hatch); may
                                                // be dropped crossing the /turn RPC if unserializable
};

// The Model seam — provider-agnostic and STREAMING-FIRST. A model yields a stream of
// deltas as it produces them; a non-streaming provider is the degenerate case (a stream
// of length 1: just `done`). `reasoning`/`text` are live tokens the engine forwards as
// TurnEvents; `done` carries the authoritative assembled ModelReply the engine checkpoints
// (the adapter owns assembly, so the engine never re-derives tool calls from partial text).
// `opts.system` is the per-turn system prompt, injected by the runtime (see withSystem).
export type ModelDelta =
  | { type: "reasoning"; text: string }   // thinking tokens (when the provider streams them)
  | { type: "text"; text: string }        // answer tokens
  | { type: "done"; reply: ModelReply };  // terminal: the full assembled reply
export type Model = (msgs: Msg[], tools: ToolSpec[], opts?: { system?: string }) => AsyncIterable<ModelDelta>;

// A one-shot model output: a single-element stream. The degenerate streaming case, for
// scripted/test models and providers without token streaming.
export function replyStream(reply: ModelReply): AsyncIterable<ModelDelta> {
  return (async function* () { yield { type: "done", reply }; })();
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
  // Ask for external (human) input and SUSPEND the turn until session.resume provides it.
  // First call throws SuspendSignal to park the turn (durably); on the replay after resume it
  // returns the stored answer. Only usable from an ASYNC tool (it awaits). `answererId`
  // defaults to the trigger user (ctx.event.user.id).
  requestInput(req: { id: string; prompt: string; schema?: unknown; answererId?: string }): Promise<unknown>;
}
export type Tool = {
  spec: ToolSpec;
  run: (input: any, ctx: ToolContext) => unknown;
  subagent?: boolean;
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
  hasUserTurn(turnId: string): boolean;
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

// What the engine persists under the `suspended` step when a turn parks: enough to
// validate a later resume (turnId, the pending request) and replay the turn (userText/
// overlay/event). One per session — turns serialize, and start() rejects new turns while
// one is parked, so a single fixed key cannot be clobbered.
type SuspendedCheckpoint = { turnId: string; callId: string; request: InputRequest; userText: string; systemOverlay?: string; event?: InboundEvent };
export type TurnTrigger =
  | { kind: "inbound"; event: InboundEvent }          // a channel event (message, mention, reaction)
  | { kind: "proactive"; by: string; note?: string }   // a schedule, another channel, the agent itself
  | { kind: "resume"; callId: string };                // continuation after an input.requested suspend
export type TurnEvent =
  | { type: "turn.started"; turnId: string; trigger: TurnTrigger }
  | { type: "action.requested"; turnId: string; call: ToolCall }
  | { type: "action.completed"; turnId: string; call: ToolCall; result: unknown }
  | { type: "message.completed"; turnId: string; text: string }
  | { type: "input.requested"; turnId: string; request: InputRequest }
  | { type: "turn.completed"; turnId: string; text: string }
  | { type: "turn.failed"; turnId: string; error: { message: string } }
  | { type: "reasoning.delta"; turnId: string; text: string }
  | { type: "message.delta"; turnId: string; text: string };
export type TurnResult =
  | { status: "completed"; text: string }
  | { status: "suspended"; request: InputRequest }
  | { status: "failed"; error: { message: string } };

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
export async function runTurn(
  store: SessionStore,
  sink: EventSink,
  model: Model,
  tools: Tool[],
  opts: { turnId: string; userText: string; crash?: Crash },
  env: { runtime: Runtime; agent: string; sessionId: string; event?: InboundEvent; systemOverlay?: string },
): Promise<string> {
  if (!store.hasUserTurn(opts.turnId)) {
    store.tx(() => store.appendMessage({ role: "user", turnId: opts.turnId, text: opts.userText }));
  }
  store.setStatus("running");
  const trigger: TurnTrigger = env.event ? { kind: "inbound", event: env.event } : { kind: "proactive", by: "system" };
  sink.emit({ type: "turn.started", turnId: opts.turnId, trigger });

  const specs = tools.map((t) => t.spec);
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
        for (const call of last.toolCalls) await toolStep(store, sink, tools, call, opts, env);
        continue;
      }
      await modelStep(store, sink, model, specs, `model:${msgs.length}`, msgs, opts, env.systemOverlay);
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
    sink.emit({ type: "turn.failed", turnId: opts.turnId, error: { message: err instanceof Error ? err.message : String(err) } });
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
  for await (const d of model(msgs, specs, systemOverlay ? { system: systemOverlay } : undefined)) {
    if (d.type === "reasoning") sink.emit({ type: "reasoning.delta", turnId: opts.turnId, text: d.text });
    else if (d.type === "text") sink.emit({ type: "message.delta", turnId: opts.turnId, text: d.text });
    else { reply = d.reply; break; } // `done` is terminal: `break` cancels the iterator (return()) so
    // extra deltas / a throw AFTER the authoritative reply can't turn a completed turn into a failure
  }
  if (!reply) throw new Error("model stream ended without a `done` event");
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
  env: { runtime: Runtime; agent: string; sessionId: string; event?: InboundEvent },
) {
  const stepId = `tool:${call.id}`;
  if (store.getStep(stepId) !== undefined) return;
  const tool = tools.find((t) => t.spec.name === call.name);
  if (!tool) throw new Error(`unknown tool ${call.name}`);
  const remote = tool.run.constructor.name === "AsyncFunction";
  const ctx: ToolContext = {
    store, runtime: env.runtime, agent: env.agent, sessionId: env.sessionId, callId: call.id, event: env.event,
    // replay-aware: return the stored answer if resume already provided it, else park the turn.
    // Answers are TURN-scoped (`input:{turnId}:{id}`): a later turn re-asking the same id must
    // park again — never silently reuse a prior turn's answer (an approval must not carry over).
    requestInput: async (req) => {
      const answer = store.getStep(`input:${opts.turnId}:${req.id}`);
      if (answer !== undefined) return (answer as { input: unknown }).input;
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

// ── the outer seam: AgentSession actor (serializes turns via an inbox) ─────────
export type TurnInput = { turnId?: string; userText: string; crash?: Crash; event?: InboundEvent };

export class AgentSession {
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
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
    const turnId = input.turnId ?? `t${++this.seq}`;
    const systemOverlay = input.event ? this.channelInstructions?.[input.event.source] : undefined;
    const run = () =>
      runTurn(
        this.store,
        this.sink,
        this.model,
        this.tools,
        { turnId, userText: input.userText, crash: input.crash },
        { runtime: this.runtime, agent: this.agent, sessionId: this.id, event: input.event, systemOverlay },
      );
    const p = this.chain.then(run);
    this.chain = p.catch(() => {}); // a failed turn must not break the inbox
    this.running.set(turnId, p); // held so result() can await a start()ed turn
    // prune on settle so `running` stays bounded (~in-flight; turns run serially) on a
    // long-lived actor. Both branches run cleanup, so the rejection is handled here — no
    // unhandled rejection (result() and the chain hold their own handlers on `p`).
    p.then(() => this.running.delete(turnId), () => this.running.delete(turnId));
    return { turnId };
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
        return { status: "failed", error: { message: err instanceof Error ? err.message : String(err) } };
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
  // `input:{inputId}` checkpoint, then replays the turn: cached steps skip, ctx.requestInput now
  // finds its answer and returns, and the turn runs on (may complete, or suspend again). `opts.by`
  // is the verified resumer — enforced against the request's answererId when set (default: the
  // trigger user). Returns { turnId } like start(); await result(turnId) for the new terminal state.
  resume(turnId: string, inputId: string, input: unknown, opts?: { by?: string }): { turnId: string } {
    const suspended = this.store.getStep("suspended") as SuspendedCheckpoint | undefined;
    if (!suspended) throw new Error(`turn ${turnId} is not suspended`);
    if (suspended.request.answererId && opts?.by !== undefined && opts.by !== suspended.request.answererId) {
      throw new Error(`resume: ${opts.by} is not authorized to answer input "${inputId}"`);
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
        { runtime: this.runtime, agent: this.agent, sessionId: this.id, event: suspended.event, systemOverlay: suspended.systemOverlay },
      );
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    this.running.set(turnId, p);
    p.then(() => this.running.delete(turnId), () => this.running.delete(turnId));
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
