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
  withSystem,
  type Broadcaster,
  type Model,
  type Msg,
  type Runtime,
  type SessionStore,
  type Tool,
} from "@junejs/core/agent-runtime";
import { channelFetch, type AgentDefinition, type ChannelContext } from "@junejs/core/agent-config";
import { openLocalSqliteSync, type SyncSqlite } from "./sqlite-driver";

function initSchema(db: SyncSqlite) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (session_id TEXT PRIMARY KEY, status TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, body TEXT)`);
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
  hasUserTurn(turnId: string): boolean {
    return this.messages().some((m) => m.role === "user" && m.turnId === turnId);
  }
  getStep(id: string): unknown | undefined {
    const r = this.db.query("SELECT output FROM agent_steps WHERE session_id = ? AND id = ?").get(this.sid, id) as { output: string } | undefined;
    return r ? JSON.parse(r.output) : undefined;
  }
  putStep(id: string, output: unknown) {
    this.db.query("INSERT INTO agent_steps (session_id, id, output) VALUES (?, ?, ?)").run(this.sid, id, JSON.stringify(output));
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
  unwrap<H = unknown>(): H { return this.db as unknown as H; }
}

class InProcBroadcaster implements Broadcaster {
  private subs = new Set<(t: string) => void>();
  publish(turnId: string) { this.subs.forEach((cb) => { try { cb(turnId); } catch { /* a bad subscriber must not break publish */ } }); }
  subscribe(cb: (t: string) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
}

// `instructions` (the agent's system prompt) is injected into the model per turn
// by the runtime (withSystem) — single-sourced on the def, not baked into `model`.
export type AgentDef = { model: Model; tools: Tool[]; instructions?: string };

// The native Runtime: a registry of agent definitions over one SQLite handle,
// handing out (and memoizing) an AgentSession actor per (agent, id).
export class NativeRuntime implements Runtime {
  private actors = new Map<string, AgentSession>();
  private readonly agents: Record<string, AgentDef>;
  private readonly db: SyncSqlite;

  constructor(agents: Record<string, AgentDef>, db: SyncSqlite) {
    this.agents = agents;
    this.db = db;
    initSchema(db);
  }

  session(agent: string, id: string): AgentSession {
    const key = `${agent}:${id}`;
    let a = this.actors.get(key);
    if (!a) {
      const def = this.agents[agent];
      if (!def) throw new Error(`unknown agent: ${agent}`);
      const model = def.instructions ? withSystem(def.model, def.instructions) : def.model;
      a = new AgentSession(agent, id, new SqliteSessionStore(this.db, key), new InProcBroadcaster(), model, def.tools, this);
      this.actors.set(key, a);
    }
    return a;
  }
}

// Open the sync SQLite handle (bun:sqlite / node:sqlite) and build a NativeRuntime
// over it. `path` defaults to ":memory:"; pass a file path for durability across
// restarts.
export async function createNativeRuntime(
  agents: Record<string, AgentDef>,
  path = ":memory:",
): Promise<NativeRuntime> {
  return new NativeRuntime(agents, await openLocalSqliteSync(path));
}

// ── memory backend — in-process, ephemeral (no DB, no disk) ───────────────────
// The lightest "no Durable Object, no persistence" option: great for dev, tests,
// and stateless previews. Same engine + seams; state is a Map that dies with the
// process. (For durability pick `native` on a long-running host or the Durable
// Object target on the edge.)
class MemorySessionStore implements SessionStore {
  private msgs: Msg[] = [];
  private steps = new Map<string, unknown>();
  private status = "new";
  appendMessage(m: Msg) { this.msgs.push(m); }
  messages(): Msg[] { return this.msgs.slice(); }
  hasUserTurn(turnId: string): boolean { return this.msgs.some((m) => m.role === "user" && m.turnId === turnId); }
  getStep(id: string): unknown | undefined { return this.steps.has(id) ? this.steps.get(id) : undefined; }
  putStep(id: string, output: unknown) { this.steps.set(id, output); }
  getStatus(): string { return this.status; }
  setStatus(s: string) { this.status = s; }
  tx<T>(fn: () => T): T { return fn(); } // no rollback: an in-memory store is not a durability tier
  unwrap<H = unknown>(): H { return undefined as unknown as H; }
}

export class MemoryRuntime implements Runtime {
  private actors = new Map<string, AgentSession>();
  private stores = new Map<string, MemorySessionStore>();
  private readonly agents: Record<string, AgentDef>;
  constructor(agents: Record<string, AgentDef>) {
    this.agents = agents;
  }
  session(agent: string, id: string): AgentSession {
    const key = `${agent}:${id}`;
    let a = this.actors.get(key);
    if (!a) {
      const def = this.agents[agent];
      if (!def) throw new Error(`unknown agent: ${agent}`);
      const store = new MemorySessionStore();
      this.stores.set(key, store);
      a = new AgentSession(agent, id, store, new InProcBroadcaster(), def.model, def.tools, this);
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
  opts: { backend?: AgentBackend; path?: string } = {},
): Promise<Runtime> {
  const backend = opts.backend ?? "native";
  if (backend === "memory") return new MemoryRuntime(agents);
  if (backend === "native") return createNativeRuntime(agents, opts.path);
  throw new Error("backend 'durable' is the Cloudflare Durable Object target — construct AgentDurableObject in your worker, not via createAgentRuntime");
}

// Mount a discovered agent on a runtime. Builds the ChannelContext whose `run`
// bridges to a durable turn, and exposes:
//   • surface(req) — the composable agent surface for June's router: a framework
//     chat endpoint at `chatPath` (POST {message, session?} → a turn) PLUS the
//     discovered channels; returns null when the request isn't an agent route.
//   • fetch(req)  — just the discovered channels (webhooks + http), null on no match.
//   • startAll()  — run one-shot channels (cli) once at boot.
export function mountAgent(
  agent: AgentDefinition,
  runtime: Runtime,
  opts: { chatPath?: string; channels?: boolean } = {},
): {
  surface: (req: Request) => Promise<Response | null>;
  fetch: (req: Request) => Promise<Response | null>;
  startAll: () => Promise<void>;
  ctx: ChannelContext;
} {
  const chatPath = opts.chatPath ?? "/message";
  const channelsOn = opts.channels ?? true;
  const ctx: ChannelContext = {
    agent,
    run: (message, o) =>
      runtime.session(agent.name, o?.session ?? "default").turn({ turnId: o?.turnId, userText: message, event: o?.event }),
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
