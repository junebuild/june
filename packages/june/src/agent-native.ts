// agent-native.ts — the NATIVE seam implementation of @junejs/core/agent-runtime.
//
// SessionStore = a session-scoped view over one shared synchronous SQLite handle
// (bun:sqlite under Bun, node:sqlite under Node — the same handle openLocalSqlite
// wraps as the async JuneDb, opened here directly because the durability tx must
// be synchronous). Broadcaster = an in-process subscriber set. Turn serialization
// comes from the AgentSession actor in core. On the edge target this same shape
// is reimplemented over a Durable Object's ctx.storage.sql (build order step 5).

import {
  AgentSession,
  grantAnswer,
  withSystem,
  type ChannelPolicy,
  type EventSink,
  type TurnEvent,
  type Model,
  type Msg,
  type PendingInputChange,
  type PendingInputHook,
  type Runtime,
  type SessionStore,
  type Tool,
} from "@junejs/core/agent-runtime";
import { buildSystemPrompt, channelFetch, type AgentDefinition, type ChannelContext } from "@junejs/core/agent-config";
import { openLocalSqliteSync, type SyncSqlite } from "./sqlite-driver";
import { assertCoreRuntimeVersion } from "./core-version";
import { observeTurnEvents } from "./turn-events";

function initSchema(db: SyncSqlite) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (session_id TEXT PRIMARY KEY, status TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, body TEXT)`);
  // Every store read is scoped to one session; without this index each one scanned the
  // messages of ALL sessions in the file (#168). IF NOT EXISTS: existing DBs gain it.
  db.exec(`CREATE INDEX IF NOT EXISTS agent_messages_session ON agent_messages (session_id, seq)`);
  // NOTE: PRIMARY KEY (session_id, id) — never id alone. The store view scopes
  // every query by session, so a step id can't leak across sessions.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_steps (session_id TEXT, id TEXT, output TEXT, PRIMARY KEY (session_id, id))`);
  // The pending-input announcement outbox (#260): outside agent_steps, so reset() never
  // archives an undelivered row. One table for every session in the file, so a restart
  // can find what is still undelivered without loading each session first.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, id TEXT, value TEXT, UNIQUE (session_id, id))`);
}

class SqliteSessionStore implements SessionStore {
  // Explicit fields (not parameter properties) — see agent-runtime.ts: keep the
  // shipped source erasable for consumers that type-strip it.
  private readonly db: SyncSqlite;
  private readonly sid: string;
  constructor(db: SyncSqlite, sid: string) {
    this.db = db;
    this.sid = sid;
  }

  appendMessage(m: Msg) {
    this.db.query("INSERT INTO agent_messages (session_id, body) VALUES (?, ?)").run(this.sid, JSON.stringify(m));
  }
  messages(): Msg[] {
    return (this.db.query("SELECT body FROM agent_messages WHERE session_id = ? ORDER BY seq").all(this.sid) as { body: string }[])
      .map((r) => JSON.parse(r.body));
  }
  // Asked once per turn start: probe for the one row instead of parsing the transcript.
  hasOpeningMessage(turnId: string): boolean {
    return this.db
      .query("SELECT 1 FROM agent_messages WHERE session_id = ? AND json_extract(body, '$.turnId') = ? AND json_extract(body, '$.role') IN ('user', 'trigger') LIMIT 1")
      .get(this.sid, turnId) != null; // bun:sqlite misses with null, node:sqlite with undefined
  }
  getStep(id: string): unknown | undefined {
    const r = this.db.query("SELECT output FROM agent_steps WHERE session_id = ? AND id = ?").get(this.sid, id) as { output: string } | undefined;
    return r ? JSON.parse(r.output) : undefined;
  }
  putStep(id: string, output: unknown) {
    this.db.query("INSERT INTO agent_steps (session_id, id, output) VALUES (?, ?, ?)").run(this.sid, id, JSON.stringify(output));
  }
  delStep(id: string) {
    this.db.query("DELETE FROM agent_steps WHERE session_id = ? AND id = ?").run(this.sid, id);
  }
  getStatus(): string {
    return (this.db.query("SELECT status FROM agent_sessions WHERE session_id = ?").get(this.sid) as { status: string } | undefined)?.status ?? "new";
  }
  setStatus(s: string) {
    this.db.query("INSERT INTO agent_sessions (session_id, status) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET status = ?").run(this.sid, s, s);
  }
  // Synchronous transaction on the single connection (sqlite is single-writer).
  // No nesting: the engine runs one tx per step, each committing before the next.
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  // OR IGNORE: an id names one change; a second write of it keeps the first's place.
  outboxPut(id: string, value: unknown) {
    this.db.query("INSERT OR IGNORE INTO agent_outbox (session_id, id, value) VALUES (?, ?, ?)").run(this.sid, id, JSON.stringify(value));
  }
  outboxList(): { id: string; value: unknown }[] {
    return (this.db.query("SELECT id, value FROM agent_outbox WHERE session_id = ? ORDER BY seq").all(this.sid) as { id: string; value: string }[])
      .map((r) => ({ id: r.id, value: JSON.parse(r.value) }));
  }
  outboxDel(id: string) {
    this.db.query("DELETE FROM agent_outbox WHERE session_id = ? AND id = ?").run(this.sid, id);
  }
  // Session reset (#129): ARCHIVE this session's messages/steps under the current
  // generation (audit trail — never deleted), clear the live rows, status → "new".
  // Archive tables + the generation counter are created lazily here, so existing
  // databases stay untouched until the first reset.
  reset(inTx?: () => void): number {
    return this.tx(() => {
      inTx?.(); // before the archive: it reads the live steps (#260)
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_messages_archive (session_id TEXT, generation INTEGER, seq INTEGER, body TEXT)`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_steps_archive (session_id TEXT, generation INTEGER, id TEXT, output TEXT)`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_session_generations (session_id TEXT PRIMARY KEY, generation INTEGER)`);
      const r = this.db.query("SELECT generation FROM agent_session_generations WHERE session_id = ?").get(this.sid) as { generation: number } | undefined;
      const generation = r?.generation ?? 0;
      this.db.query("INSERT INTO agent_messages_archive (session_id, generation, seq, body) SELECT session_id, ?, seq, body FROM agent_messages WHERE session_id = ?").run(generation, this.sid);
      this.db.query("DELETE FROM agent_messages WHERE session_id = ?").run(this.sid);
      this.db.query("INSERT INTO agent_steps_archive (session_id, generation, id, output) SELECT session_id, ?, id, output FROM agent_steps WHERE session_id = ?").run(generation, this.sid);
      this.db.query("DELETE FROM agent_steps WHERE session_id = ?").run(this.sid);
      this.db.query("INSERT INTO agent_sessions (session_id, status) VALUES (?, 'new') ON CONFLICT(session_id) DO UPDATE SET status = 'new'").run(this.sid);
      this.db.query("INSERT INTO agent_session_generations (session_id, generation) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET generation = ?").run(this.sid, generation + 1, generation + 1);
      return generation;
    });
  }
  unwrap<H = unknown>(): H { return this.db as unknown as H; }
}

class InProcEventSink implements EventSink {
  private subs = new Set<(e: TurnEvent) => void>();
  // The runtime's own listener (pending-input delivery, #260). Not a subscriber: it is
  // not counted in `size`, so it never keeps an idle actor from being evicted.
  private readonly onEvent?: (e: TurnEvent) => void;
  constructor(onEvent?: (e: TurnEvent) => void) { this.onEvent = onEvent; }
  emit(e: TurnEvent) {
    this.subs.forEach((cb) => { try { cb(e); } catch { /* a bad subscriber must not break emit */ } });
    try { this.onEvent?.(e); } catch { /* likewise */ }
  }
  subscribe(cb: (e: TurnEvent) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
  get size(): number { return this.subs.size; }
}

// Pending-input delivery for the in-process runtimes (#260): hands a session's outbox to
// the agent's onPendingInput after every park or resolution and whenever the session is
// (re)built. A failure keeps the rows and retries on a timer, 5 s doubling to 5 min —
// unref'd, so a pending retry never holds the process open.
function pendingInputDeliverer(agent: string, sessionId: string, hook: PendingInputHook, session: () => AgentSession): () => void {
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deliver = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    session().deliverPendingInputChanges(hook).then(
      () => { failures = 0; },
      (err) => {
        const delay = Math.min(5_000 * 2 ** failures, 300_000);
        failures++;
        console.error(`[june] agent "${agent}" session "${sessionId}": onPendingInput failed (attempt ${failures}); the announcement is kept and retried in ${delay / 1000}s:`, err);
        timer = setTimeout(deliver, delay);
        (timer as { unref?: () => void }).unref?.();
      },
    );
  };
  return deliver;
}

// The session's sink, wired to deliver pending-input announcements when the agent has a
// hook. `session` is read lazily: the sink exists before the AgentSession it serves.
function sessionSink(agent: string, sessionId: string, def: AgentDef, session: () => AgentSession): { sink: InProcEventSink; deliver?: () => void } {
  if (!def.onPendingInput) return { sink: new InProcEventSink() };
  const deliver = pendingInputDeliverer(agent, sessionId, def.onPendingInput, session);
  const sink = new InProcEventSink((e) => {
    if (e.type === "input.requested" || e.type === "input.resolved") deliver();
  });
  return { sink, deliver };
}

// `instructions` (the agent's system prompt) is injected into the model per turn
// by the runtime (withSystem) — single-sourced on the def, not baked into `model`.
// `onPendingInput` (#260): the runtime delivers the agent's pending-input announcements
// to it — see AgentDefinition.onPendingInput.
export type AgentDef = { model: Model; tools: Tool[]; instructions?: string; channelInstructions?: Record<string, string | ChannelPolicy>; onPendingInput?: PendingInputHook };

// The runtime-side def for an assembled AgentDefinition (#173): the tools (channel
// capability tools and read_skill included), the system prompt (instructions + the
// skill index) and the per-surface policies all come from the ONE definition that
// mountAgent mounts, so the engine and the channels can't drift apart. Only the model
// is the host's choice.
//   createNativeRuntime({ [agent.name]: toAgentDef(agent, anthropic({ … })) })
export function toAgentDef(agent: AgentDefinition, model: Model): AgentDef {
  return {
    model,
    tools: agent.tools,
    instructions: buildSystemPrompt(agent),
    ...(agent.channelInstructions ? { channelInstructions: agent.channelInstructions } : {}),
    ...(agent.onPendingInput ? { onPendingInput: agent.onPendingInput } : {}),
  };
}

export type NativeRuntimeOptions = {
  // Soft cap on memoized session actors (#174), default 1000. Past it, the least recently
  // used IDLE actors (no turn running or queued, no reset pending, no live subscriber) are
  // dropped; their state is in SQLite, so the next session() rebuilds them transparently.
  // Busy actors are never dropped, so the count can exceed the cap while they run.
  maxSessions?: number;
};

// The native Runtime: a registry of agent definitions over one SQLite handle,
// handing out (and memoizing) an AgentSession actor per (agent, id). The memo is an
// LRU bounded by maxSessions — with slackChannel every thread is a session, so an
// unbounded memo grew by one actor per thread for the life of the process.
// Callers must not hold an AgentSession across an await and start turns on it later:
// if it was evicted meanwhile, a fresh actor for the same session would run turns
// unserialized with it. Call session() at the point of use (mountAgent does).
export class NativeRuntime implements Runtime {
  private actors = new Map<string, { session: AgentSession; sink: InProcEventSink }>();
  private readonly agents: Record<string, AgentDef>;
  private readonly db: SyncSqlite;
  private readonly maxSessions: number;

  constructor(agents: Record<string, AgentDef>, db: SyncSqlite, opts: NativeRuntimeOptions = {}) {
    assertCoreRuntimeVersion("NativeRuntime"); // #94: fail power-on, not mid-turn
    this.agents = agents;
    this.db = db;
    const max = opts.maxSessions ?? 1000;
    // At least one actor is always retained (the one being handed out), so a cap below 1
    // means nothing, and NaN would compare false and evict every idle actor on each miss.
    // Infinity is allowed: an explicit "no cap".
    if (!(Number.isInteger(max) && max >= 1) && max !== Infinity) {
      throw new RangeError(`NativeRuntime: maxSessions must be an integer >= 1 (or Infinity for no cap), got ${max}`);
    }
    this.maxSessions = max;
    initSchema(db);
  }

  agentDef(name: string): AgentDef | undefined { return this.agents[name]; }

  session(agent: string, id: string): AgentSession {
    const key = `${agent}:${id}`;
    const hit = this.actors.get(key);
    if (hit) {
      // most recently used → the tail (Map iteration order is insertion order)
      this.actors.delete(key);
      this.actors.set(key, hit);
      return hit.session;
    }
    const def = this.agents[agent];
    if (!def) throw new Error(`unknown agent: ${agent}`);
    const model = def.instructions ? withSystem(def.model, def.instructions) : def.model;
    // Delivery resolves the session through the runtime, never a captured instance: an
    // evicted-then-rebuilt actor must not be delivered from twice in parallel (#260).
    const { sink, deliver } = sessionSink(agent, id, def, () => this.session(agent, id));
    const session = new AgentSession(agent, id, new SqliteSessionStore(this.db, key), sink, model, def.tools, this, def.channelInstructions);
    this.evictIdle();
    this.actors.set(key, { session, sink });
    deliver?.(); // what a previous actor or process committed but never delivered
    return session;
  }

  // Deliver every pending-input announcement left undelivered in the database (#260) — a
  // process that stopped between a commit and its delivery. Builds the sessions that have
  // rows, which delivers them (session() does on every build). Called once at startup by
  // createNativeRuntime; safe to call again.
  recoverPendingInput(): void {
    // The agent and session come from the change itself, not from splitting the store key
    // (`${agent}:${id}`): an agent name may contain ":" too. One row per session is enough.
    const rows = this.db.query("SELECT value FROM agent_outbox WHERE seq IN (SELECT MIN(seq) FROM agent_outbox GROUP BY session_id)").all() as { value: string }[];
    for (const { value } of rows) {
      const { agent, session } = JSON.parse(value) as PendingInputChange;
      if (this.agents[agent]?.onPendingInput) this.session(agent, session);
    }
  }

  // Number of memoized actors (observability / tests).
  get sessionCount(): number { return this.actors.size; }

  // Drop least recently used idle actors until one more fits under the cap. Runs before
  // the new actor is inserted, so the actor being handed out is never a candidate.
  private evictIdle() {
    if (this.actors.size < this.maxSessions) return;
    for (const [key, a] of this.actors) {
      if (this.actors.size < this.maxSessions) break;
      if (a.session.idle() && a.sink.size === 0) this.actors.delete(key);
    }
  }
}

// Open the sync SQLite handle (bun:sqlite / node:sqlite) and build a NativeRuntime
// over it. `path` defaults to ":memory:"; pass a file path for durability across
// restarts.
export async function createNativeRuntime(
  agents: Record<string, AgentDef>,
  path = ":memory:",
  opts: NativeRuntimeOptions = {},
): Promise<NativeRuntime> {
  const runtime = new NativeRuntime(agents, await openLocalSqliteSync(path), opts);
  runtime.recoverPendingInput(); // #260
  return runtime;
}

// ── memory backend — in-process, ephemeral (no DB, no disk) ───────────────────
// The lightest "no Durable Object, no persistence" option: great for dev, tests,
// and stateless previews. Same engine + seams; state is a Map that dies with the
// process — and is never evicted (the actor IS the state), so it grows with every
// session: not for a long-running host with unbounded sessions. (For durability pick `native` on a long-running host or the Durable
// Object target on the edge.)
class MemorySessionStore implements SessionStore {
  private msgs: Msg[] = [];
  private steps = new Map<string, unknown>();
  private status = "new";
  private generation = 0;
  // Retired generations (#129) — kept for the audit contract even in memory, so the
  // backend behaves like the durable tiers within one process lifetime.
  private readonly archives: { generation: number; msgs: Msg[]; steps: Map<string, unknown> }[] = [];
  appendMessage(m: Msg) { this.msgs.push(m); }
  messages(): Msg[] { return this.msgs.slice(); }
  hasOpeningMessage(turnId: string): boolean { return this.msgs.some((m) => (m.role === "user" || m.role === "trigger") && m.turnId === turnId); }
  getStep(id: string): unknown | undefined { return this.steps.has(id) ? this.steps.get(id) : undefined; }
  putStep(id: string, output: unknown) { this.steps.set(id, output); }
  delStep(id: string) { this.steps.delete(id); }
  getStatus(): string { return this.status; }
  setStatus(s: string) { this.status = s; }
  tx<T>(fn: () => T): T { return fn(); } // no rollback: an in-memory store is not a durability tier
  private outbox = new Map<string, unknown>(); // insertion-ordered; never archived (#260)
  outboxPut(id: string, value: unknown) { if (!this.outbox.has(id)) this.outbox.set(id, value); }
  outboxList(): { id: string; value: unknown }[] { return [...this.outbox].map(([id, value]) => ({ id, value })); }
  outboxDel(id: string) { this.outbox.delete(id); }
  reset(inTx?: () => void): number {
    inTx?.(); // before the archive: it reads the live steps (#260)
    const generation = this.generation++;
    this.archives.push({ generation, msgs: this.msgs, steps: this.steps });
    this.msgs = [];
    this.steps = new Map();
    this.status = "new";
    return generation;
  }
  unwrap<H = unknown>(): H { return undefined as unknown as H; }
}

export class MemoryRuntime implements Runtime {
  private actors = new Map<string, AgentSession>();
  private stores = new Map<string, MemorySessionStore>();
  private readonly agents: Record<string, AgentDef>;
  constructor(agents: Record<string, AgentDef>) {
    assertCoreRuntimeVersion("MemoryRuntime"); // #94: fail power-on, not mid-turn
    this.agents = agents;
  }
  agentDef(name: string): AgentDef | undefined { return this.agents[name]; }
  session(agent: string, id: string): AgentSession {
    const key = `${agent}:${id}`;
    let a = this.actors.get(key);
    if (!a) {
      const def = this.agents[agent];
      if (!def) throw new Error(`unknown agent: ${agent}`);
      const store = new MemorySessionStore();
      this.stores.set(key, store);
      // Same def handling as NativeRuntime: switching backend must not change behavior.
      const model = def.instructions ? withSystem(def.model, def.instructions) : def.model;
      const { sink } = sessionSink(agent, id, def, () => this.session(agent, id)); // #260
      a = new AgentSession(agent, id, store, sink, model, def.tools, this, def.channelInstructions);
      this.actors.set(key, a);
    }
    return a;
  }
}

// The selectable agent-runtime backends. `native` (SQLite via june/host, durable
// on a long-running host) and `memory` (ephemeral) are in-process runtimes built
// here; `durable` is the Cloudflare Durable Object target (see agent-durable.ts —
// constructed by the worker, not here).
export type AgentBackend = "native" | "memory" | "durable";

// Build an in-process runtime for the chosen backend. Throws for `durable` (that
// target is the DO the worker constructs, not an in-process object) — so the
// choice is explicit and a mis-selection fails loudly.
export async function createAgentRuntime(
  agents: Record<string, AgentDef>,
  opts: { backend?: AgentBackend; path?: string; maxSessions?: number } = {},
): Promise<Runtime> {
  const backend = opts.backend ?? "native";
  if (backend === "memory") return new MemoryRuntime(agents);
  if (backend === "native") return createNativeRuntime(agents, opts.path, { maxSessions: opts.maxSessions });
  throw new Error("backend 'durable' is the Cloudflare Durable Object target — construct AgentDurableObject in your worker, not via createAgentRuntime");
}

// #173: the engine runs the runtime's AgentDef, the channels see the AgentDefinition —
// declared separately by hand, they drift silently (a tool the model can't call, a
// channel capability tool the engine never got). Say so once at mount. Only the
// in-process runtimes expose their def; tools compare by name.
function warnOnDrift(agent: AgentDefinition, runtime: Runtime) {
  const def = (runtime as { agentDef?: (name: string) => AgentDef | undefined }).agentDef?.(agent.name);
  if (!def) return;
  const names = (tools: Tool[]) => tools.map((t) => t.spec.name).sort();
  const want = names(agent.tools), have = names(def.tools);
  if (want.join("\0") !== have.join("\0")) {
    const missing = want.filter((n) => !have.includes(n)), extra = have.filter((n) => !want.includes(n));
    console.warn(
      `[june] mountAgent("${agent.name}"): the runtime's tools differ from the agent definition's` +
        (missing.length ? ` — missing from the runtime: ${missing.join(", ")}` : "") +
        (extra.length ? ` — only in the runtime: ${extra.join(", ")}` : "") +
        `. Build the runtime entry with toAgentDef(agent, model) so both come from one definition.`,
    );
  }
}

// Mount a discovered agent on a runtime. Builds the ChannelContext the channels drive
// turns through — run, runDetached, runStream, resumeStream and resetSession, each over
// the runtime's in-process session. Not provided: runDelivered/resumeDelivered, which
// exist to escape the edge waitUntil ceiling (a native host has none; channels fall back
// to runStream/resumeStream without them). Exposes:
//   • surface(req) — the composable agent surface for June's router: a framework
//     chat endpoint at `chatPath` (POST {message, session?} → a turn) PLUS the
//     discovered channels; returns null when the request isn't an agent route.
//   • fetch(req)  — just the discovered channels (webhooks + http), null on no match.
//   • startAll()  — run one-shot channels (cli) once at boot.
export function mountAgent(
  agent: AgentDefinition,
  runtime: Runtime,
  opts: { chatPath?: string; channels?: boolean; services?: unknown } = {},
): {
  surface: (req: Request) => Promise<Response | null>;
  fetch: (req: Request) => Promise<Response | null>;
  startAll: () => Promise<void>;
  ctx: ChannelContext;
} {
  const chatPath = opts.chatPath ?? "/message";
  const channelsOn = opts.channels ?? true;
  warnOnDrift(agent, runtime);
  const ctx: ChannelContext = {
    agent,
    services: opts.services, // same DI bag reachable from channel hooks (parity with durableChannelSurface)
    run: (message, o) =>
      runtime.session(agent.name, o?.session ?? "default").turn({ turnId: o?.turnId, userText: message, event: o?.event, trigger: o?.trigger, replace: o?.replace }),
    // FIRE-AND-FORGET (#77): start() without awaiting the result. Native has no waitUntil
    // ceiling (Node keeps floating promises alive), but the seam is the same so a channel
    // written against ctx.runDetached behaves identically on both targets.
    runDetached: async (message, o) =>
      runtime.session(agent.name, o?.session ?? "default").start({ turnId: o?.turnId, userText: message, event: o?.event, trigger: o?.trigger, replace: o?.replace }),
    // LIVE (#169): the turn's event stream, so a channel renders as the turn runs —
    // slackChannel({ stream: true }) edits in place here exactly as on the edge, instead of
    // silently degrading to one post at the end. Lazy like the DO's (the turn starts on the
    // first pull); start()/resume() and the subscription run with nothing awaited between,
    // so no event can emit unobserved.
    runStream: async function* (message, o) {
      const session = runtime.session(agent.name, o?.session ?? "default");
      const { turnId } = session.start({ turnId: o?.turnId, userText: message, event: o?.event, trigger: o?.trigger, replace: o?.replace });
      yield* observeTurnEvents(session, turnId);
    },
    // HITL: answer a parked turn and stream its continuation (the approval-button path).
    resumeStream: async function* (o) {
      const session = runtime.session(agent.name, o.session ?? "default");
      // A { policy } answerer is the app's call (#261): decided here, before the synchronous
      // resume, so resume-then-subscribe stays free of awaits.
      const granted = await grantAnswer(session, o, agent.authorizeAnswer);
      const { turnId } = session.resume(o.turnId, o.inputId, o.input, { by: o.by, granted });
      yield* observeTurnEvents(session, turnId);
    },
    // SESSION RESET (#129): same seam as durableChannelSurface — the in-process runtimes'
    // stores implement archival, so a channel written against ctx.resetSession behaves
    // identically on both targets.
    resetSession: (o) => runtime.session(agent.name, o?.session ?? "default").reset(),
  };
  const channels = channelFetch(agent, ctx);
  const surface = async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === chatPath) {
      const { message, session } = (await req.json()) as { message: string; session?: string };
      return Response.json({ text: await ctx.run(message, { session }) });
    }
    return channelsOn ? channels(req) : null;
  };
  return {
    ctx,
    surface,
    fetch: channels,
    startAll: async () => {
      await Promise.all(agent.channels.filter((c) => c.start).map((c) => c.start!(ctx)));
    },
  };
}
