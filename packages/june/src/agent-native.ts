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
  type InputAnnouncement,
  type TurnEvent,
  type Model,
  type Msg,
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
  // Session reset (#129): ARCHIVE this session's messages/steps under the current
  // generation (audit trail — never deleted), clear the live rows, status → "new".
  // Archive tables + the generation counter are created lazily here, so existing
  // databases stay untouched until the first reset.
  reset(inTx?: () => void): number {
    return this.tx(() => {
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
      inTx?.(); // writes into the fresh generation, committed with the archive (#260)
      return generation;
    });
  }
  unwrap<H = unknown>(): H { return this.db as unknown as H; }
}

class InProcEventSink implements EventSink {
  private subs = new Set<(e: TurnEvent) => void>();
  emit(e: TurnEvent) { this.subs.forEach((cb) => { try { cb(e); } catch { /* a bad subscriber must not break emit */ } }); }
  subscribe(cb: (e: TurnEvent) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
  get size(): number { return this.subs.size; }
}

// `instructions` (the agent's system prompt) is injected into the model per turn
// by the runtime (withSystem) — single-sourced on the def, not baked into `model`.
export type AgentDef = {
  model: Model;
  tools: Tool[];
  instructions?: string;
  channelInstructions?: Record<string, string | ChannelPolicy>;
  // The app's receiver for input announcements (#260), installed on every session this
  // runtime builds; undelivered announcements from an earlier process are flushed then.
  onInputAnnouncement?: (a: InputAnnouncement) => void | Promise<void>;
};

// Retries a failed announcement delivery on a timer (#260): the engine keeps an undelivered
// announcement and flushes again on the next announcement, settled turn or rebuild — but a
// session that goes quiet would hold it until then. 5 s doubling to 5 min, per session;
// unref'd, so a pending retry never holds the process open. Owned by the runtime, so the
// backoff survives an evicted-and-rebuilt actor.
class AnnouncementRetry {
  // Explicit fields (not parameter properties) — keep the shipped source erasable.
  private readonly flush: (agent: string, id: string) => void;
  private readonly state = new Map<string, { failures: number; timer?: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  constructor(flush: (agent: string, id: string) => void) {
    this.flush = flush;
  }
  delivered(key: string) {
    const s = this.state.get(key);
    if (s?.timer) clearTimeout(s.timer);
    this.state.delete(key);
  }
  failed(key: string, agent: string, id: string) {
    if (this.stopped) return; // the runtime is closed: nothing retries into it
    const s = this.state.get(key) ?? { failures: 0 };
    this.state.set(key, s);
    if (s.timer) return; // one retry pending at a time
    const delay = Math.min(5_000 * 2 ** s.failures, 300_000);
    s.failures++;
    s.timer = setTimeout(() => { s.timer = undefined; this.flush(agent, id); }, delay);
    (s.timer as { unref?: () => void }).unref?.();
  }
  // Cancel every pending retry, for good (#317): unref only keeps a timer from holding the
  // process open — it still fires while the process lives, into a runtime (and a db) that
  // is gone.
  stop() {
    this.stopped = true;
    for (const s of this.state.values()) if (s.timer) clearTimeout(s.timer);
    this.state.clear();
  }
}

// SQLite handles a runtime opened itself (createNativeRuntime), so close() closes those and
// never one a caller passed in.
const ownedDbs = new WeakSet<SyncSqlite>();

// Install the announcement hook on a freshly built session and deliver what an earlier life
// of it recorded but never delivered (#260). The flush never rejects; it logs — and a
// failure schedules a retry.
function wireAnnouncements(session: AgentSession, def: AgentDef, retry: AnnouncementRetry): AgentSession {
  const hook = def.onInputAnnouncement;
  if (hook) {
    const key = `${session.agent}:${session.id}`;
    session.onAnnounce = async (a) => {
      try {
        await hook(a);
      } catch (err) {
        retry.failed(key, session.agent, session.id);
        throw err; // the engine keeps the announcement and logs
      }
      retry.delivered(key);
    };
    void session.flushAnnouncements();
  }
  return session;
}

// The step the engine keeps its announcement outbox under (#260) — read by the native
// runtime's startup scan. Mirrors ANNOUNCE_OUTBOX in @junejs/core/agent-runtime.
const ANNOUNCE_OUTBOX_STEP = "announce-outbox";

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
    ...(agent.onInputAnnouncement ? { onInputAnnouncement: agent.onInputAnnouncement } : {}),
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
  // Retries failed announcement deliveries (#260), across actor rebuilds.
  private readonly announceRetry = new AnnouncementRetry((agent, id) => { void this.session(agent, id).flushAnnouncements(); });
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
    const sink = new InProcEventSink();
    const session = wireAnnouncements(new AgentSession(agent, id, new SqliteSessionStore(this.db, key), sink, model, def.tools, this, def.channelInstructions), def, this.announceRetry);
    this.evictIdle();
    this.actors.set(key, { session, sink });
    return session;
  }

  // Number of memoized actors (observability / tests).
  get sessionCount(): number { return this.actors.size; }

  // Deliver announcements an earlier process recorded but never delivered (#260), without
  // waiting for their sessions to be used again: build every session whose outbox is not
  // empty — building one flushes it. The agent and session come from the announcement
  // itself, not from splitting the store key (an agent name may contain ":"). Called once
  // by createNativeRuntime; safe to call again.
  recoverAnnouncements(): void {
    const rows = this.db.query("SELECT output FROM agent_steps WHERE id = ?").all(ANNOUNCE_OUTBOX_STEP) as { output: string }[];
    for (const { output } of rows) {
      const [first] = JSON.parse(output) as InputAnnouncement[];
      if (first && this.agents[first.agent]?.onInputAnnouncement) this.session(first.agent, first.session);
    }
  }

  // Shut the runtime down (#317): cancel pending announcement retries and drop the actors;
  // close the SQLite handle if createNativeRuntime opened it (a db passed to the constructor
  // stays the caller's). Call it before discarding a runtime in a process that keeps
  // running — a test suite, a host that swaps runtimes — or a retry fires later against a
  // closed or deleted database. Safe to call twice.
  close(): void {
    this.announceRetry.stop();
    this.actors.clear();
    if (ownedDbs.has(this.db)) {
      ownedDbs.delete(this.db);
      this.db.close();
    }
  }

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
  const db = await openLocalSqliteSync(path);
  ownedDbs.add(db);
  const runtime = new NativeRuntime(agents, db, opts);
  runtime.recoverAnnouncements(); // #260
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
  reset(inTx?: () => void): number {
    const generation = this.generation++;
    this.archives.push({ generation, msgs: this.msgs, steps: this.steps });
    this.msgs = [];
    this.steps = new Map();
    this.status = "new";
    inTx?.(); // writes into the fresh generation (#260)
    return generation;
  }
  unwrap<H = unknown>(): H { return undefined as unknown as H; }
}

export class MemoryRuntime implements Runtime {
  private actors = new Map<string, AgentSession>();
  private stores = new Map<string, MemorySessionStore>();
  private readonly agents: Record<string, AgentDef>;
  private readonly announceRetry = new AnnouncementRetry((agent, id) => { void this.session(agent, id).flushAnnouncements(); }); // #260
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
      a = wireAnnouncements(new AgentSession(agent, id, store, new InProcEventSink(), model, def.tools, this, def.channelInstructions), def, this.announceRetry);
      this.actors.set(key, a);
    }
    return a;
  }
  // Shut the runtime down (#317): cancel pending announcement retries. The state is the
  // actors themselves, so they are dropped too. Safe to call twice.
  close(): void {
    this.announceRetry.stop();
    this.actors.clear();
    this.stores.clear();
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
