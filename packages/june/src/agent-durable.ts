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
  ResumeAuthorizationError,
  withSystem,
  type EventSink,
  type TurnEvent,
  type Model,
  type Msg,
  type Runtime,
  type InboundEvent,
  type SessionStore,
  type ProactiveTrigger,
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
  hasOpeningMessage(turnId: string): boolean {
    return this.messages().some((m) => (m.role === "user" || m.role === "trigger") && m.turnId === turnId);
  }
  getStep(id: string): unknown | undefined {
    const rows = this.sql.exec<{ output: string }>("SELECT output FROM agent_steps WHERE id = ?", id).toArray();
    return rows.length ? JSON.parse(rows[0]!.output) : undefined;
  }
  putStep(id: string, output: unknown) {
    this.sql.exec("INSERT INTO agent_steps (id, output) VALUES (?, ?)", id, JSON.stringify(output));
  }
  delStep(id: string) {
    this.sql.exec("DELETE FROM agent_steps WHERE id = ?", id);
  }
  getStatus(): string {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM agent_meta WHERE k = 'status'").toArray();
    return rows.length ? rows[0]!.v : "new";
  }
  setStatus(s: string) {
    this.sql.exec("INSERT INTO agent_meta (k, v) VALUES ('status', ?) ON CONFLICT(k) DO UPDATE SET v = ?", s, s);
  }
  // The externally-assigned session key (#75). A DO cannot read its own idFromName
  // name, so the key arrives on the first routed request and is persisted here —
  // surviving hibernation/eviction, where the constructor re-runs with no request
  // in hand. Not part of core's SessionStore contract: only the DO seam needs it.
  getSessionKey(): string | undefined {
    const rows = this.sql.exec<{ v: string }>("SELECT v FROM agent_meta WHERE k = 'session_key'").toArray();
    return rows.length ? rows[0]!.v : undefined;
  }
  setSessionKey(key: string) {
    this.sql.exec("INSERT INTO agent_meta (k, v) VALUES ('session_key', ?) ON CONFLICT(k) DO UPDATE SET v = ?", key, key);
  }
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  unwrap<H = unknown>(): H {
    return this.sql as unknown as H;
  }
}

class InProcEventSink implements EventSink {
  private subs = new Set<(e: TurnEvent) => void>();
  emit(e: TurnEvent) { this.subs.forEach((cb) => { try { cb(e); } catch { /* a bad subscriber must not break emit */ } }); }
  subscribe(cb: (e: TurnEvent) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
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
  // Per-channel-source system overlays (see AgentDefinition.channelInstructions) — the
  // shared agent branches by real inbound source, no userText marker.
  channelInstructions?: Record<string, string>;
  // Channels whose CAPABILITY tools should be available to this session's turns. Their
  // tools are built HERE, in the DO isolate, from `env` — because a channel's tool `run`
  // is a closure (over the bot token, etc.) that can't cross the worker→DO RPC. This is
  // the edge equivalent of defineAgent merging channel.tools() on native: pass the same
  // channel factories you mount on the worker, plus this DO's env.
  channels?: (Channel | ChannelFactory)[];
  env?: unknown;
  resources?: Resources;
  services?: unknown;
  // Called on every turn.failed for this session — the app's seam for routing turn
  // failures to its own telemetry (Sentry, a ledger, …). Providing it REPLACES the
  // default console.error; if the hook throws (or an async hook rejects), the default
  // log fires anyway (both errors), so a failure is never silent. It happens to run
  // inside the failed turn's request scope today (turn.failed is emitted mid-turn and
  // ALS propagates), but that is NOT contract — don't rely on ambient db/services;
  // close over what you need.
  onTurnError?: (failure: { turnId: string; error: { message: string } }) => void | Promise<void>;
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
  // The AgentSession is constructed LAZILY (#75): the DO is keyed externally by
  // idFromName(`${agent}:${session}`) but cannot read its own name, so the true
  // session key only exists on a routed request (the SESSION_HEADER durableFetch
  // sets). First keyed request wins and persists the key (agent_meta) so it
  // survives hibernation; key-less paths fall back to the persisted key, then
  // "self" (the pre-#75 behavior, kept for backward compatibility).
  private session: AgentSession | undefined;
  private sessionKey: string | undefined;
  private readonly name: string;
  private readonly store: DoSessionStore;
  private readonly sink: InProcEventSink;
  private readonly model: Model;
  private readonly tools: Tool[];
  private readonly channelInstructions?: Record<string, string>;
  // Built from the DO's env in the constructor (this isolate), shared across turns —
  // env is stable per isolate, like bindWorkerResources memoizes per worker isolate.
  private readonly resources: Resources;
  private readonly services: unknown;
  constructor(state: DurableObjectState, def: DoAgentDef) {
    const store = new DoSessionStore(state.storage);
    const model = def.instructions ? withSystem(def.model, def.instructions) : def.model;
    this.resources = def.resources ?? {};
    this.services = def.services;
    const name = def.name ?? "agent";
    // Failure observability (#76): a turn that dies after the fast-ACK has no other
    // observable surface on the edge — the webhook already 200'd and runBackground
    // swallows the rejection unless the channel wired onError. Subscribing HERE (the
    // session sink) covers every turn path — turn(), /turn, /resume — with one seam.
    // Default: console.error, which wrangler tail surfaces. An app onTurnError takes
    // over reporting; if IT throws, fall back to the default so nothing goes silent.
    // (InProcEventSink already guards emit against a throwing subscriber.)
    const sink = new InProcEventSink();
    sink.subscribe((e) => {
      if (e.type !== "turn.failed") return;
      const defaultLog = () => console.error(`[june] agent "${name}" turn ${e.turnId} failed: ${e.error.message}`);
      if (def.onTurnError) {
        try {
          const out = def.onTurnError({ turnId: e.turnId, error: e.error });
          // An async hook (e.g. `await sendToSentry(...)`) types as void but returns a
          // Promise — a rejection there must hit the same fallback as a sync throw, or
          // the failure goes silent again (plus an unhandled rejection). No waitUntil
          // keeper is needed here: unlike a Worker, a DO stays active while it has
          // pending work/IO, and DurableObjectState.waitUntil is documented as a no-op —
          // this .then subscription is what retains the promise.
          if (out && typeof (out as Promise<void>).then === "function") {
            (out as Promise<void>).then(undefined, (hookErr) => {
              console.error(`[june] agent "${name}": onTurnError hook rejected:`, hookErr);
              defaultLog();
            });
          }
          return;
        } catch (hookErr) {
          console.error(`[june] agent "${name}": onTurnError hook threw:`, hookErr);
        }
      }
      defaultLog();
    });
    // Merge the mounted channels' capability tools (built here from this DO's env, since a
    // tool's `run` closure can't cross the RPC). The cross-channel source gate on each tool
    // keeps a Slack tool inert during a Crisp turn, so merging all of them is safe.
    const channelTools = (def.channels ?? []).flatMap((c) => resolveChannel(c, def.env).tools?.() ?? []);
    const tools: Tool[] = [...def.tools];
    const seen = new Set(tools.map((t) => t.spec.name));
    for (const t of channelTools) {
      if (seen.has(t.spec.name)) throw new Error(`AgentDurableObject(${def.name ?? "agent"}): duplicate tool name "${t.spec.name}" from a channel — rename so dispatch is unambiguous.`);
      seen.add(t.spec.name);
      tools.push(t);
    }
    this.name = name;
    this.store = store;
    this.sink = sink;
    this.model = model;
    this.tools = tools;
    this.channelInstructions = def.channelInstructions;
  }
  // Resolve THE session for this DO: explicit key (from a routed request) → persisted
  // key (a prior life learned it) → "self". A key that contradicts the persisted or
  // live identity is a mis-route (or a key-less path was used first) — fail loudly:
  // silently proceeding is exactly the per-conversation data corruption #75 hit.
  private resolveSession(key?: string): AgentSession {
    const stored = this.store.getSessionKey();
    if (key !== undefined && stored !== undefined && key !== stored) {
      throw new Error(`agent "${this.name}": request session "${key}" does not match this object's session "${stored}" — one DO is one session; mis-routed durableFetch?`);
    }
    if (this.session) {
      if (key !== undefined && this.sessionKey !== key) {
        throw new Error(`agent "${this.name}": request session "${key}" does not match the live session "${this.sessionKey}" — the session was first used without a key; route every request through durableFetch`);
      }
      return this.session;
    }
    const resolved = key ?? stored ?? "self";
    if (key !== undefined && stored === undefined) this.store.setSessionKey(key);
    this.sessionKey = resolved;
    this.session = new AgentSession(this.name, resolved, this.store, this.sink, this.model, this.tools, crossDoUnsupported, this.channelInstructions);
    return this.session;
  }
  // Run the whole turn inside a request scope seeded from this DO's env, so ambient
  // `db`/`kv`/`blob` and `currentServices()` resolve inside a tool exactly as in a
  // route loader. `locals` is intentionally NOT set here: a fresh scope object per
  // turn means a fresh (lazily-created) locals Map per turn, so per-turn state (e.g.
  // Juno's batch-loader registry) can't leak across turns on a long-lived DO.
  // ensureScope() lazily wires node:async_hooks (workerd via nodejs_compat), as the
  // pipeline does; without it runInScope is a pass-through and ambient reads throw.
  async turn(input: { turnId?: string; userText: string; event?: InboundEvent; trigger?: ProactiveTrigger; session?: string }): Promise<string> {
    await ensureScope();
    const session = this.resolveSession(input.session);
    return runInScope({ resources: this.resources, services: this.services }, () => session.turn(input));
  }
  // Read-only: folds the durable log. Key-less reads must NOT commit "self" as this
  // object's identity (a later keyed /turn would then hard-conflict), so an unresolved
  // session folds through an ephemeral, uncached AgentSession instead.
  transcript() {
    const session = this.session ?? new AgentSession(this.name, this.store.getSessionKey() ?? "self", this.store, this.sink, this.model, this.tools, crossDoUnsupported, this.channelInstructions);
    return session.transcript();
  }
  // Default HTTP surface: POST …/turn STREAMS the turn's TurnEvents as SSE (start the
  // turn in-scope, then stream from the session sink); GET …/transcript reads the log.
  // The app can call turn()/transcript() directly instead (turn() awaits the final text).
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // The session key durableFetch stamped on the routed request (#75); absent on a
    // hand-rolled fetch → the pre-#75 "self" fallback keeps old callers working.
    const key = req.headers.get(SESSION_HEADER) ?? undefined;
    if (req.method === "POST" && url.pathname.endsWith("/turn")) {
      const { userText, turnId, event, trigger } = (await req.json()) as { userText: string; turnId?: string; event?: InboundEvent; trigger?: ProactiveTrigger };
      await ensureScope();
      // start() schedules the turn on the chain WITHIN the scope, so it runs with ambient
      // db/services (ALS propagates to the .then continuation registered here); subscribing
      // happens synchronously right after, before any event can emit.
      let session: AgentSession;
      let started: { turnId: string };
      try {
        session = this.resolveSession(key);
        started = runInScope({ resources: this.resources, services: this.services }, () => session.start({ userText, turnId, event, trigger }));
      } catch (err) {
        // e.g. the session is suspended awaiting input, or the key mis-matches this
        // object's identity — a client-resolvable conflict, not a crash
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
      }
      return new Response(sseTurnStream(session, started.turnId), { headers: SSE_HEADERS });
    }
    // Provide the input a suspended turn is waiting on and stream its continuation as SSE.
    // NOTE: this default surface passes `by` straight from the body — the engine treats it as a
    // VERIFIED identity, so the app must authenticate it upstream (e.g. take the user id from a
    // signature-checked Slack interaction payload), never expose this endpoint raw to clients.
    if (req.method === "POST" && url.pathname.endsWith("/resume")) {
      const { turnId, inputId, input, by } = (await req.json()) as { turnId: string; inputId: string; input: unknown; by?: string };
      await ensureScope();
      let session: AgentSession;
      try {
        session = this.resolveSession(key);
        runInScope({ resources: this.resources, services: this.services }, () => session.resume(turnId, inputId, input, { by }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 403: the resumer may not answer; 409: not suspended / wrong turn / wrong input id / key mismatch
        return Response.json({ error: message }, { status: err instanceof ResumeAuthorizationError ? 403 : 409 });
      }
      return new Response(sseTurnStream(session, turnId), { headers: SSE_HEADERS });
    }
    if (url.pathname.endsWith("/transcript")) {
      // A keyed read still conflict-checks (and may commit the key — it is authentic,
      // idFromName routed it here); a key-less read stays non-committal via transcript().
      if (key !== undefined) {
        try {
          return Response.json({ transcript: this.resolveSession(key).transcript() });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
        }
      }
      return Response.json({ transcript: this.transcript() });
    }
    return new Response("agent DO — POST /turn, POST /resume, or GET /transcript", { status: 404 });
  }
}

// ── SSE transport for the turn event stream (crosses the worker→DO isolate) ───
// The DO streams a turn's TurnEvents as text/event-stream; the worker either pipes
// that straight to a browser (live chat) or collapses it to the final text (channels).
// no-store (not no-cache): an intermediary must NOT store chat/user content at all, and it
// matches the repo's other SSE surface (dev-reload).
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-store" };

// A ReadableStream of SSE frames from a session's live event stream, scoped to one turn
// and closed on its terminal event. Subscribes synchronously (no replay needed — we start
// the turn then subscribe before any event can emit). A `:hb` comment heartbeat keeps the
// connection alive across long model/tool gaps (a silent SSE stream gets culled by idle
// timeouts on hosts/proxies) — cleared on terminal close and on cancel.
function sseTurnStream(session: AgentSession, turnId: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => { unsub?.(); clearInterval(heartbeat); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(":hb\n\n")); } catch { clearInterval(heartbeat); }
      }, 20_000);
      unsub = session.observe((e) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        // terminal for the STREAM: completed, failed, OR suspended (input.requested → the turn
        // parked; the stream ends and a later /resume opens a fresh continuation stream).
        if (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "input.requested") { stop(); controller.close(); }
      }, { turnId });
    },
    cancel() { stop(); },
  });
}

// Consume an SSE turn stream to its terminal state: the final text, or throw on failure.
// The non-streaming path (channels, a JSON chat response) uses this. Guards a non-SSE /
// body-less upstream response (a misroute or an error) into a clear error, not a TypeError.
export async function sseTurnFinalText(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body || !ct.includes("text/event-stream")) {
    const detail = res.body ? (await res.text()).slice(0, 200) : "no body";
    throw new Error(`turn stream: expected an SSE response, got ${ct || "no content-type"} (status ${res.status}): ${detail}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const e = JSON.parse(line.slice(5).trim()) as TurnEvent;
      if (e.type === "turn.completed") return e.text;
      if (e.type === "turn.failed") throw new Error(e.error.message);
    }
    if (done) break;
  }
  throw new Error("turn stream ended without a terminal event");
}

// Parse an SSE turn response into the stream of TurnEvents (skipping `:hb` heartbeats).
// The streaming consumer (a channel's render path) iterates this to drive live UI.
export async function* sseTurnEvents(res: Response): AsyncIterable<TurnEvent> {
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body || !ct.includes("text/event-stream")) {
    const detail = res.body ? (await res.text()).slice(0, 200) : "no body";
    throw new Error(`turn stream: expected an SSE response, got ${ct || "no content-type"} (status ${res.status}): ${detail}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
      buf = buf.slice(i + 2);
      if (line) yield JSON.parse(line.slice(5).trim()) as TurnEvent;
    }
    if (done) break;
  }
}

// The header durableFetch stamps the session key on (#75). A DO cannot read its own
// idFromName name, so this is how the externally-assigned session identity crosses
// into the object — exported so a custom shell that bypasses durableFetch can set it.
export const SESSION_HEADER = "x-june-session";

// Worker-side routing: address a session's DO by (agent, session) and forward the
// request to it. `env.AGENT` is the DO namespace binding. The session key rides a
// header (not the body): one seam covers /turn, /resume, and /transcript without
// touching any body contract, and an older DO simply ignores it.
export function durableFetch(namespace: DurableObjectNamespace, agent: string, session: string, req: Request): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set(SESSION_HEADER, session);
  return namespace.get(namespace.idFromName(`${agent}:${session}`)).fetch(new Request(req, { headers }));
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
    // Forward to the session's DO on its /turn contract — which now STREAMS SSE. A client
    // that asks for the stream (Accept: text/event-stream) gets live TurnEvents piped
    // through; otherwise collapse to the final { text } (the prior JSON contract).
    const res = await durableFetch(
      namespace,
      opts.agentName,
      session ?? "default",
      new Request("https://do/turn", { method: "POST", body: JSON.stringify({ userText: message }) }),
    );
    if (req.headers.get("accept")?.includes("text/event-stream")) return res;
    return Response.json({ text: await sseTurnFinalText(res) });
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
// env.AGENT when it mounts channels. Returns null for unclaimed requests.
export function durableChannelSurface(
  getNamespace: () => DurableObjectNamespace | undefined,
  opts: {
    agentName: string;
    channels: (Channel | ChannelFactory)[];
    env: unknown;
    // The app's services factory — the SAME one AgentDurableObject uses — resolved HERE
    // (worker isolate) and exposed to channel hooks as ctx.services. Channel hooks run at
    // the edge, outside the DO, so they can't read the DO's ambient currentServices(); this
    // gives them the same DI bag. Resolved once per surface construction.
    services?: (env: unknown) => unknown;
    waitUntil?: (p: Promise<unknown>) => void;
  },
): (req: Request) => Promise<Response | null> {
  const resolved = opts.channels.map((c) => resolveChannel(c, opts.env));
  const ctx: ChannelContext = {
    // A minimal but complete AgentDefinition — channels only read ctx.agent.name; the
    // full def isn't present in the worker (tools/model live in the DO).
    agent: { name: opts.agentName, instructions: "", tools: [], skills: [], channels: [], connections: [] } satisfies AgentDefinition,
    services: opts.services?.(opts.env),
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
      // /turn streams SSE; the simple path collapses it to the final text.
      return sseTurnFinalText(res);
    },
    // The LIVE path: hand the channel the TurnEvent stream so it can render as the turn runs.
    runStream: async function* (message, o) {
      const namespace = getNamespace();
      if (!namespace) throw new Error("durableChannelSurface: no Durable Object namespace bound (env.AGENT)");
      const res = await durableFetch(
        namespace,
        opts.agentName,
        o?.session ?? "default",
        new Request("https://do/turn", { method: "POST", body: serializeTurn(message, o) }),
      );
      yield* sseTurnEvents(res);
    },
    // Resume a parked turn on its session's DO and stream the continuation.
    resumeStream: async function* (o) {
      const namespace = getNamespace();
      if (!namespace) throw new Error("durableChannelSurface: no Durable Object namespace bound (env.AGENT)");
      const res = await durableFetch(
        namespace,
        opts.agentName,
        o.session ?? "default",
        new Request("https://do/resume", { method: "POST", body: serializeResume(o) }),
      );
      yield* sseTurnEvents(res);
    },
  };
  return channelDispatch(resolved, ctx);
}

// Serialize a turn for the /turn RPC body. InboundEvent.raw is `unknown` — the
// untouched platform payload — so a (third-party) channel could attach something
// JSON.stringify chokes on (a circular object, a BigInt). raw isn't needed to route or
// run the turn, so on a serialization failure we drop it rather than let an
// unserializable payload take down turn forwarding entirely. (raw is optional on
// InboundEvent precisely because it may not survive this boundary.)
// Serialize a /resume RPC body. `input` is `unknown` — the human's answer — so a
// (third-party) host could hand us something JSON.stringify chokes on (BigInt, circular).
// Unlike serializeTurn's `raw`, `input` is essential: silently dropping it would resume the
// turn with the wrong answer. So fail loudly with a clear message rather than corrupt the resume.
function serializeResume(o: { turnId: string; inputId: string; input: unknown; by?: string }): string {
  try {
    return JSON.stringify({ turnId: o.turnId, inputId: o.inputId, input: o.input, by: o.by });
  } catch (err) {
    throw new Error(`resumeStream: input is not JSON-serializable (${(err as Error).message}) — a resume answer must round-trip to the DO`);
  }
}

// `trigger` is ProactiveTrigger — plain strings by construction — so only event.raw can make
// the stringify throw; the fallback that strips it stays sufficient.
function serializeTurn(userText: string, o?: { turnId?: string; event?: InboundEvent; trigger?: ProactiveTrigger }): string {
  const payload = { userText, turnId: o?.turnId, event: o?.event, trigger: o?.trigger };
  try {
    return JSON.stringify(payload);
  } catch {
    const event = o?.event ? { ...o.event, raw: undefined } : undefined;
    return JSON.stringify({ ...payload, event });
  }
}
