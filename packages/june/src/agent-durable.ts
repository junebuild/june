// agent-durable.ts — the EDGE seam: the agent runtime on a Cloudflare Durable
// Object (a first-class edge target). A DO is the natural home for the
// AgentSession actor: it is single-threaded (turn serialization for free), it has
// a synchronous SQLite at `ctx.storage.sql` + `ctx.storage.transactionSync` (the
// edge analog of the native sync handle, so the SAME durability contract holds),
// and it can hibernate between turns.
//
// Elegance of the mapping: ONE DO instance = ONE session, so the store needs no
// session_id column at all — the DO boundary IS the session boundary. (Native
// shares one DB across sessions, hence its (session_id, id) keys.)
//
// This module follows the monorepo's no-external-types discipline: the Cloudflare
// surface is described by MINIMAL structural interfaces, and it does NOT import
// `cloudflare:workers` — so it typechecks and unit-tests under Bun/Node against a
// fake SqlStorage. The app supplies the thin `extends DurableObject` shell (that
// one import only exists in the app's worker, which only runs on workerd).

import {
  AgentSession,
  type Broadcaster,
  type Model,
  type Msg,
  type Runtime,
  type SessionStore,
  type Tool,
} from "@junejs/core/agent-runtime";

// ── minimal structural Cloudflare surface (no @cloudflare/workers-types dep) ──
export interface SqlStorageCursor<T = Record<string, unknown>> {
  toArray(): T[];
  one(): T;
}
export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}
export interface DurableStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}
export interface DurableObjectState {
  storage: DurableStorage;
}
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

// ── the DO SessionStore over ctx.storage.sql (synchronous) ────────────────────
// No session_id: one DO = one session. tx is a real synchronous storage tx, so
// the exactly-once contract (side effect + checkpoint + append in one tx) holds
// on the edge exactly as it does natively.
export class DoSessionStore implements SessionStore {
  constructor(private storage: DurableStorage) {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_steps (id TEXT PRIMARY KEY, output TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_meta (k TEXT PRIMARY KEY, v TEXT)`);
  }
  private get sql() {
    return this.storage.sql;
  }
  appendMessage(m: Msg) {
    this.sql.exec("INSERT INTO agent_messages (body) VALUES (?)", JSON.stringify(m));
  }
  messages(): Msg[] {
    return this.sql.exec<{ body: string }>("SELECT body FROM agent_messages ORDER BY seq").toArray().map((r) => JSON.parse(r.body));
  }
  hasUserTurn(turnId: string): boolean {
    return this.messages().some((m) => m.role === "user" && m.turnId === turnId);
  }
  getStep(id: string): unknown | undefined {
    const rows = this.sql.exec<{ output: string }>("SELECT output FROM agent_steps WHERE id = ?", id).toArray();
    return rows.length ? JSON.parse(rows[0]!.output) : undefined;
  }
  putStep(id: string, output: unknown) {
    this.sql.exec("INSERT INTO agent_steps (id, output) VALUES (?, ?)", id, JSON.stringify(output));
  }
  getStatus(): string {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM agent_meta WHERE k = 'status'").toArray();
    return rows.length ? rows[0]!.v : "new";
  }
  setStatus(s: string) {
    this.sql.exec("INSERT INTO agent_meta (k, v) VALUES ('status', ?) ON CONFLICT(k) DO UPDATE SET v = ?", s, s);
  }
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  unwrap<H = unknown>(): H {
    return this.sql as unknown as H;
  }
}

class InProcBroadcaster implements Broadcaster {
  private subs = new Set<(t: string) => void>();
  publish(turnId: string) { this.subs.forEach((cb) => { try { cb(turnId); } catch { /* a bad subscriber must not break publish */ } }); }
  subscribe(cb: (t: string) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
}

// A DO can't run in-process subagents; a subagent there is a sibling DO (cross-DO
// RPC — a follow-up). Until then, an agent WITHOUT subagent tools never touches
// this, and one WITH them fails loudly rather than silently mis-running.
const crossDoUnsupported: Runtime = {
  session() {
    throw new Error("subagents on the Durable Object target require cross-DO wiring (not yet implemented)");
  },
};

export type DoAgentDef = { name?: string; model: Model; tools: Tool[] };

// The agent runtime INSIDE a Durable Object. A plain class (constructor takes the
// DO state) so this module needs no `cloudflare:workers` import — the app extends
// the real DurableObject and delegates:
//
//   import { DurableObject } from "cloudflare:workers";
//   import { AgentDurableObject } from "@junejs/server/agent-durable";
//   export class JuneAgentDO extends DurableObject {
//     private agent = new AgentDurableObject(this.ctx, { model, tools });
//     fetch(req: Request) { return this.agent.fetch(req); }
//   }
export class AgentDurableObject {
  private session: AgentSession;
  constructor(state: DurableObjectState, def: DoAgentDef) {
    const store = new DoSessionStore(state.storage);
    this.session = new AgentSession(def.name ?? "agent", "self", store, new InProcBroadcaster(), def.model, def.tools, crossDoUnsupported);
  }
  turn(input: { turnId?: string; userText: string }): Promise<string> {
    return this.session.turn(input);
  }
  transcript() {
    return this.session.transcript();
  }
  // Default HTTP surface: POST …/turn runs a durable turn; GET …/transcript reads
  // the log. The app can call turn()/transcript() directly instead.
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/turn")) {
      const { userText, turnId } = (await req.json()) as { userText: string; turnId?: string };
      return Response.json({ text: await this.turn({ userText, turnId }) });
    }
    if (url.pathname.endsWith("/transcript")) return Response.json({ transcript: this.transcript() });
    return new Response("agent DO — POST /turn or GET /transcript", { status: 404 });
  }
}

// Worker-side routing: address a session's DO by (agent, session) and forward the
// request to it. `env.AGENT` is the DO namespace binding.
export function durableFetch(namespace: DurableObjectNamespace, agent: string, session: string, req: Request): Promise<Response> {
  return namespace.get(namespace.idFromName(`${agent}:${session}`)).fetch(req);
}
