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
  withSystem,
  type Broadcaster,
  type Model,
  type Msg,
  type Runtime,
  type InboundEvent,
  type SessionStore,
  type Tool,
} from "@junejs/core/agent-runtime";
import type { Resources } from "@junejs/core/resources";
import {
  channelDispatch,
  resolveChannel,
  type AgentDefinition,
  type Channel,
  type ChannelContext,
  type ChannelFactory,
} from "@junejs/core/agent-config";
import { ensureScope, runInScope } from "@junejs/db";

// ── minimal structural Cloudflare surface (no @cloudflare/workers-types dep) ──
// SqlStorage row values are exactly what workerd's SQLite returns. Mirroring
// @cloudflare/workers-types' `T extends Record<string, SqlStorageValue>` constraint
// STRUCTURALLY (not importing it) makes `this.ctx.storage` directly assignable to
// these interfaces, so a DO shell needs no `as unknown as JuneDoState` cast. The
// constraint (not just a default) is what lets the two `exec` signatures unify:
// an unconstrained `T` promises `toArray(): T[]` for arbitrary T, which workerd's
// cursor — only ever `Record<string, SqlStorageValue>` rows — cannot satisfy.
export type SqlStorageValue = ArrayBuffer | string | number | null;
export interface SqlStorageCursor<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>> {
  toArray(): T[];
  one(): T;
}
export interface SqlStorage {
  exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T>;
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
  // Explicit field (not a parameter property) — keep the shipped source erasable.
  private readonly storage: DurableStorage;
  constructor(storage: DurableStorage) {
    this.storage = storage;
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

// `instructions` (system prompt) is injected into the model per turn (withSystem),
// so it need not be baked into `model` at construction — single-sourced on the def.
//
// `resources` / `services` are the DI seam that closes the isolate gap: a DO is a
// SEPARATE isolate from the Worker entry, reached by RPC, so the pipeline's request
// scope (and its ambient `db`/`kv`/`blob`) never crosses into it. Instead the app
// builds these from the DO's OWN env in the DO constructor (where env lives) and the
// AgentDurableObject runs every turn inside a scope holding them — so a tool reads
// ambient `db` (from `resources`) and app-defined services (via `currentServices()`)
// exactly as a route loader does, with no module-global setter and no `env` on ctx.
//   • resources — db/kv/blob handles bound from env (e.g. `{ db: d1(env.DB) }`).
//   • services  — the app's own bag for things June doesn't model (Vectorize,
//     Workers AI, a ledger writer, a retriever). Opaque here; the app types it at
//     the `currentServices<T>()` read.
export type DoAgentDef = {
  name?: string;
  model: Model;
  tools: Tool[];
  instructions?: string;
  resources?: Resources;
  services?: unknown;
};

// The agent runtime INSIDE a Durable Object. A plain class (constructor takes the
// DO state) so this module needs no `cloudflare:workers` import. The app supplies
// the thin shell in its worker — a class extending Cloudflare's DurableObject
// base (the `cloudflare:workers` export, imported there, not here) that news up an
// AgentDurableObject from `this.ctx` and forwards `fetch()`:
//
//   export class JuneAgentDO extends DurableObject {
//     agent = new AgentDurableObject(this.ctx, {
//       model, tools,
//       resources: { db: d1(this.env.DB) },   // ambient `db` inside tools
//       services: makeServices(this.env),     // retriever, ledger writer, Vectorize…
//     });
//     fetch(req) { return this.agent.fetch(req); }
//   }
export class AgentDurableObject {
  private session: AgentSession;
  // Built from the DO's env in the constructor (this isolate), shared across turns —
  // env is stable per isolate, like bindWorkerResources memoizes per worker isolate.
  private readonly resources: Resources;
  private readonly services: unknown;
  constructor(state: DurableObjectState, def: DoAgentDef) {
    const store = new DoSessionStore(state.storage);
    const model = def.instructions ? withSystem(def.model, def.instructions) : def.model;
    this.resources = def.resources ?? {};
    this.services = def.services;
    this.session = new AgentSession(def.name ?? "agent", "self", store, new InProcBroadcaster(), model, def.tools, crossDoUnsupported);
  }
  // Run the whole turn inside a request scope seeded from this DO's env, so ambient
  // `db`/`kv`/`blob` and `currentServices()` resolve inside a tool exactly as in a
  // route loader. `locals` is intentionally NOT set here: a fresh scope object per
  // turn means a fresh (lazily-created) locals Map per turn, so per-turn state (e.g.
  // Juno's batch-loader registry) can't leak across turns on a long-lived DO.
  // ensureScope() lazily wires node:async_hooks (workerd via nodejs_compat), as the
  // pipeline does; without it runInScope is a pass-through and ambient reads throw.
  async turn(input: { turnId?: string; userText: string; event?: InboundEvent }): Promise<string> {
    await ensureScope();
    return runInScope({ resources: this.resources, services: this.services }, () => this.session.turn(input));
  }
  transcript() {
    return this.session.transcript();
  }
  // Default HTTP surface: POST …/turn runs a durable turn; GET …/transcript reads
  // the log. The app can call turn()/transcript() directly instead.
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/turn")) {
      const { userText, turnId, event } = (await req.json()) as { userText: string; turnId?: string; event?: InboundEvent };
      return Response.json({ text: await this.turn({ userText, turnId, event }) });
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

// The EDGE agent surface for June's router: route the chat endpoint to the
// per-session Durable Object. `getNamespace` reads the DO binding off the
// per-fetch env (like the env-aware resources provider), so the surface is null
// (fall through) when no DO is bound. Returns null for non-chat requests.
//
// Channel webhooks on the edge route by a session derived from the platform
// payload (slack channel:thread, crisp website:session) — that needs parsing
// before picking the DO, so it's a follow-up; this ships the chat endpoint.
export function durableAgentSurface(
  getNamespace: () => DurableObjectNamespace | undefined,
  opts: { agentName: string; chatPath?: string },
): (req: Request) => Promise<Response | null> {
  const chatPath = opts.chatPath ?? "/message";
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== chatPath) return null;
    const namespace = getNamespace();
    if (!namespace) return null; // no DO binding → not mounted here
    const { message, session } = (await req.json()) as { message: string; session?: string };
    // Forward to the session's DO on its /turn contract (AgentDurableObject.fetch).
    return durableFetch(
      namespace,
      opts.agentName,
      session ?? "default",
      new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: message }) }),
    );
  };
}

// The EDGE channel surface: mount an agent's INBOUND channels (Slack/Crisp webhooks,
// an http endpoint) on the Worker entry and route each turn into the per-session
// Durable Object. The sibling of durableAgentSurface, which mounts only the chat
// endpoint; a worker composes both (`await chat(req) ?? await channels(req) ?? 404`).
//
// Channels are resolved from the Worker's `env`, because on workerd a signing secret
// lives only there (never at module top-level) — so a channel module can default-
// export a factory: `export default (env) => crispChannel({ signingSecret:
// env.CRISP_SIGNATURE_SECRET, ... })`. `waitUntil` (workerd's `ctx.waitUntil`) keeps
// the isolate alive for the fast-ACK background work (run the turn, post the reply
// back out). The webhook's own signature check still runs first, in the channel.
//
//   export default {
//     fetch(req, env, ctx) {
//       const channels = durableChannelSurface(() => env.AGENT, {
//         agentName: "crisp-support", channels: [crispCh], env,
//         waitUntil: ctx.waitUntil.bind(ctx),
//       });
//       return channels(req).then((r) => r ?? new Response("not found", { status: 404 }));
//     },
//   }
//
// Note: if the DO namespace is unbound, a matched webhook still ACKs but the turn
// fails in the background — surfaced via the channel's onError IF one is configured,
// otherwise swallowed (runBackground never rejects). The app is expected to bind
// Serialize a turn for the /turn RPC body. InboundEvent.raw is `unknown` — the
// untouched platform payload — so a (third-party) channel could attach something
// JSON.stringify chokes on (a circular object, a BigInt). raw isn't needed to route or
// run the turn, so on a serialization failure we drop it rather than let an
// unserializable payload take down turn forwarding entirely.
function serializeTurn(userText: string, o?: { turnId?: string; event?: InboundEvent }): string {
  const payload = { userText, turnId: o?.turnId, event: o?.event };
  try {
    return JSON.stringify(payload);
  } catch {
    const event = o?.event ? { ...o.event, raw: undefined } : undefined;
    return JSON.stringify({ ...payload, event });
  }
}

// env.AGENT when it mounts channels. Returns null for unclaimed requests.
export function durableChannelSurface(
  getNamespace: () => DurableObjectNamespace | undefined,
  opts: {
    agentName: string;
    channels: (Channel | ChannelFactory)[];
    env: unknown;
    waitUntil?: (p: Promise<unknown>) => void;
  },
): (req: Request) => Promise<Response | null> {
  const resolved = opts.channels.map((c) => resolveChannel(c, opts.env));
  const ctx: ChannelContext = {
    // A minimal but complete AgentDefinition — channels only read ctx.agent.name; the
    // full def isn't present in the worker (tools/model live in the DO).
    agent: { name: opts.agentName, instructions: "", tools: [], skills: [], channels: [], connections: [] } satisfies AgentDefinition,
    waitUntil: opts.waitUntil,
    run: async (message, o) => {
      const namespace = getNamespace();
      if (!namespace) throw new Error("durableChannelSurface: no Durable Object namespace bound (env.AGENT)");
      const res = await durableFetch(
        namespace,
        opts.agentName,
        o?.session ?? "default",
        new Request("https://do/turn", { method: "POST", body: serializeTurn(message, o) }),
      );
      const { text } = (await res.json()) as { text: string };
      return text;
    },
  };
  return channelDispatch(resolved, ctx);
}
