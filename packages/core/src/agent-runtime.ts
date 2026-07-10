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
  channelId: string;                            // slack channel id / crisp website:session
  threadId?: string;                            // thread root (slack thread_ts / crisp session)
  ts: string;                                   // this event's message ts
  user?: { id: string; name?: string };         // WHO
  text?: string;                                // message / app_mention carry text; reactions don't
  reaction?: { name: string; itemTs: string };  // WHICH emoji, on WHICH message
  raw: unknown;                                 // untouched platform payload (escape hatch)
};

// The Model seam — provider-agnostic. `opts.system` is the per-turn system prompt
// (an agent's instructions); optional so the engine can call `model(msgs, specs)`
// and a scripted model can ignore it. The runtime injects it from the agent def
// (see withSystem) so instructions are single-sourced and can't be dropped.
export type Model = (msgs: Msg[], tools: ToolSpec[], opts?: { system?: string }) => Promise<ModelReply>;

// Wrap a Model so every call carries `system` (the agent's instructions). The
// runtime applies this from the agent def, so a provider model needn't bake the
// system prompt in at construction — one model instance can serve many agents,
// each supplying its own system per turn. The def's system is authoritative.
export function withSystem(model: Model, system: string): Model {
  return (msgs, tools, opts) => model(msgs, tools, { ...opts, system });
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
  getStatus(): string;
  setStatus(s: string): void;
  tx<T>(fn: () => T): T; // synchronous transaction
  // Escape hatch to the underlying storage handle, so a local tool can write its
  // own app table inside `tx` (exactly-once). On native this is the host sync
  // SQLite handle; on an edge target it is ctx.storage.sql.
  unwrap<H = unknown>(): H;
}

export interface Broadcaster {
  publish(turnId: string): void;
  subscribe(cb: (turnId: string) => void): () => void;
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
  bcast: Broadcaster,
  model: Model,
  tools: Tool[],
  opts: { turnId: string; userText: string; crash?: Crash },
  env: { runtime: Runtime; agent: string; sessionId: string; event?: InboundEvent },
): Promise<string> {
  if (!store.hasUserTurn(opts.turnId)) {
    store.tx(() => store.appendMessage({ role: "user", turnId: opts.turnId, text: opts.userText }));
  }
  store.setStatus("running");
  bcast.publish(opts.turnId);

  const specs = tools.map((t) => t.spec);
  while (true) {
    const msgs = store.messages();
    // Non-null: the loop always runs with ≥1 message (the user turn is appended
    // above before the first iteration), so the transcript is never empty here.
    const last = msgs[msgs.length - 1]!;

    if (last.role === "assistant" && last.toolCalls.length === 0) {
      store.setStatus("done");
      bcast.publish(opts.turnId);
      return last.text;
    }
    if (last.role === "assistant" && last.toolCalls.length > 0) {
      for (const call of last.toolCalls) await toolStep(store, bcast, tools, call, opts, env);
      continue;
    }
    await modelStep(store, bcast, model, specs, `model:${msgs.length}`, msgs, opts);
  }
}

async function modelStep(
  store: SessionStore,
  bcast: Broadcaster,
  model: Model,
  specs: ToolSpec[],
  stepId: string,
  msgs: Msg[],
  opts: { turnId: string; crash?: Crash },
) {
  if (store.getStep(stepId) !== undefined) return; // cached: assistant already appended in the same tx
  const reply = await model(msgs, specs);
  assertCrash(opts.crash, "before-model-commit", stepId); // nothing persisted → replay re-asks the model
  store.tx(() => {
    store.putStep(stepId, reply);
    store.appendMessage({ role: "assistant", turnId: opts.turnId, text: reply.text, toolCalls: reply.toolCalls });
  });
  assertCrash(opts.crash, "after-model-commit", stepId); // committed → replay skips (exactly-once append)
  bcast.publish(opts.turnId);
}

async function toolStep(
  store: SessionStore,
  bcast: Broadcaster,
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
  const ctx: ToolContext = { store, runtime: env.runtime, agent: env.agent, sessionId: env.sessionId, callId: call.id, event: env.event };

  assertCrash(opts.crash, "before-tool-commit", stepId); // nothing done → safe clean re-run
  const toolMsg = (result: unknown): Msg => ({ role: "tool", turnId: opts.turnId, toolCallId: call.id, name: call.name, result });

  if (remote) {
    // network / subagent side effect: at-least-once (can't 2PC with local storage;
    // a subagent is itself durable, and its child turnId makes replay idempotent)
    const out = await tool.run(call.input, ctx);
    store.tx(() => { store.putStep(stepId, out); store.appendMessage(toolMsg(out)); });
  } else {
    // local side effect: exactly-once (side effect + checkpoint + append in ONE tx)
    store.tx(() => {
      const out = tool.run(call.input, ctx);
      store.putStep(stepId, out);
      store.appendMessage(toolMsg(out));
    });
  }
  assertCrash(opts.crash, "after-tool-commit", stepId); // committed → replay skips (no duplicate side effect)
  bcast.publish(opts.turnId);
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
export class AgentSession {
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  // Explicit fields + assignment (not constructor parameter properties): June
  // ships raw .ts, so consumers type-strip it — parameter properties aren't
  // erasable and break `erasableSyntaxOnly` / Node native strip-types.
  private readonly agent: string;
  private readonly id: string;
  private readonly store: SessionStore;
  private readonly bcast: Broadcaster;
  private readonly model: Model;
  private readonly tools: Tool[];
  private readonly runtime: Runtime;
  constructor(agent: string, id: string, store: SessionStore, bcast: Broadcaster, model: Model, tools: Tool[], runtime: Runtime) {
    this.agent = agent;
    this.id = id;
    this.store = store;
    this.bcast = bcast;
    this.model = model;
    this.tools = tools;
    this.runtime = runtime;
  }

  // turns are serialized: each awaits the previous. Two concurrent turn() calls
  // to the same session run one-after-another — no interleaving on the shared
  // transcript. (On a Durable Object this is blockConcurrencyWhile; here it's a
  // promise chain. Same guarantee, both targets.)
  turn(input: { turnId?: string; userText: string; crash?: Crash; event?: InboundEvent }): Promise<string> {
    const turnId = input.turnId ?? `t${++this.seq}`;
    const run = () =>
      runTurn(
        this.store,
        this.bcast,
        this.model,
        this.tools,
        { turnId, userText: input.userText, crash: input.crash },
        { runtime: this.runtime, agent: this.agent, sessionId: this.id, event: input.event },
      );
    const p = this.chain.then(run);
    this.chain = p.catch(() => {}); // a failed turn must not break the inbox
    return p;
  }

  observe(cb: (turnId: string) => void): () => void { return this.bcast.subscribe(cb); }
  transcript(): Turn[] { return foldTranscript(this.store.messages()); }
  snapshot() { return { transcript: this.transcript(), status: this.store.getStatus() }; }
}

// Address space: a runtime resolves a session actor by (agentName, id). Native =
// an in-process map (@junejs/server); edge = idFromName on a DO namespace.
export interface Runtime {
  session(agent: string, id: string): AgentSession;
}
