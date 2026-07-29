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
  type TurnError,
  type TurnFailurePhase,
} from "@junejs/core/agent-runtime";
import type { Resources } from "@junejs/core/resources";
import {
  channelDispatch,
  DeliverUnsupportedError,
  resolveChannel,
  type AgentDefinition,
  type Channel,
  type ChannelContext,
  type ChannelFactory,
  type ResumeDeliveryTarget,
} from "@junejs/core/agent-config";
import { ensureScope, runInScope } from "@junejs/db";
import { isolateLocal } from "./isolate-local";
import { assertCoreRuntimeVersion } from "./core-version";

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
  // log fires anyway (both errors), so a failure is never silent. `error` carries the
  // full serialized failure (stack, cause chain — see TurnError, #96), and phase/step
  // name the engine step that was in flight — for a DETACHED turn this hook is the
  // only failure-surfacing path, so nothing may be flattened before it fires. It
  // happens to run inside the failed turn's request scope today (turn.failed is
  // emitted mid-turn and ALS propagates), but that is NOT contract — don't rely on
  // ambient db/services; close over what you need.
  onTurnError?: (failure: { turnId: string; error: TurnError; phase?: TurnFailurePhase; step?: string }) => void | Promise<void>;
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
  private readonly channels: Channel[];
  private readonly channelInstructions?: Record<string, string>;
  // Built from the DO's env in the constructor (this isolate), shared across turns —
  // env is stable per isolate, like bindWorkerResources memoizes per worker isolate.
  private readonly resources: Resources;
  private readonly services: unknown;
  constructor(state: DurableObjectState, def: DoAgentDef) {
    assertCoreRuntimeVersion(`AgentDurableObject(${def.name ?? "agent"})`); // #94: fail power-on, not mid-turn
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
      // The stack already opens with the message; log it INSTEAD of the message line
      // when present so wrangler tail shows one coherent trace, not the message twice.
      const defaultLog = () =>
        console.error(`[june] agent "${name}" turn ${e.turnId} failed${e.step ? ` at ${e.step}` : ""}: ${e.error.stack ?? e.error.message}${e.error.causeChain?.length ? `\ncaused by: ${e.error.causeChain.join(" ← ")}` : ""}`);
      if (def.onTurnError) {
        try {
          const out = def.onTurnError({ turnId: e.turnId, error: e.error, phase: e.phase, step: e.step });
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
    // keeps a Slack tool inert during a Crisp turn, so merging all of them is safe. The
    // resolved channels are also RETAINED (this.channels): a delivered turn (/turn?deliver=1)
    // renders its reply through the source channel's deliver() from inside this DO.
    const channels = (def.channels ?? []).map((c) => resolveChannel(c, def.env));
    const channelTools = channels.flatMap((c) => c.tools?.() ?? []);
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
    this.channels = channels;
    this.channelInstructions = def.channelInstructions;
  }
  // Resolve THE session for this DO: explicit key (from a routed request) → persisted
  // key (a prior life learned it) → "self". A key that contradicts the persisted or
  // live identity is a mis-route (or a key-less path was used first) — fail loudly:
  // silently proceeding is exactly the per-conversation data corruption #75 hit.
  private resolveSession(key?: string): AgentSession {
    // Every entry point shares the session-key contract (turn({ session }) and hand-rolled
    // SESSION_HEADER values included, not just durableFetch): an invalid key persisted here
    // would bind an identity no routed request could ever address — an orphaned session.
    if (key !== undefined) assertSessionKey(key);
    // Live fast path — no storage read once the session exists: this method is the only
    // writer of the persisted key, so within one life it cannot diverge from the live one.
    if (this.session) {
      if (key !== undefined && this.sessionKey !== key) {
        throw new Error(
          this.sessionKey === "self"
            ? `agent "${this.name}": request session "${key}" arrived, but this session is bound to the placeholder "self" (first used without a real key) — carry the key on every path (route through durableFetch, or pass turn({ session }) on the direct API)`
            : `agent "${this.name}": request session "${key}" does not match this object's session "${this.sessionKey}" — one DO is one session; address each session by its own key (durableFetch, or turn({ session }) on the direct API)`,
        );
      }
      return this.session;
    }
    const stored = this.store.getSessionKey();
    if (key !== undefined && stored !== undefined && key !== stored) {
      throw new Error(`agent "${this.name}": request session "${key}" does not match this object's session "${stored}" — one DO is one session; address each session by its own key (durableFetch, or turn({ session }) on the direct API)`);
    }
    const resolved = key ?? stored ?? "self";
    // "self" is deliberately NOT persisted — even when a caller passes it EXPLICITLY: it
    // is a placeholder ("no identity externally assigned yet"), not an identity. Within
    // one life a keyed request after a "self" binding is refused above — two concurrently
    // active paths disagreeing is a live bug. But across eviction a keyed request ADOPTS
    // the legacy transcript: that asymmetry IS the migration path from pre-keyed
    // deployments, where a persisted "self" would 409 every keyed request forever.
    if (key !== undefined && key !== "self" && stored === undefined) this.store.setSessionKey(key);
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
  // Fire-and-forget for custom shells (#77): resolves once the turn is durably ACCEPTED;
  // it then runs under the DO's own lifetime (a DO stays alive while it has pending
  // work), not the caller's. No live consumer sees the result — failures surface via
  // the default turn-failure log / onTurnError (#76).
  async start(input: { turnId?: string; userText: string; event?: InboundEvent; trigger?: ProactiveTrigger; session?: string }): Promise<{ turnId: string }> {
    await ensureScope();
    const session = this.resolveSession(input.session);
    return runInScope({ resources: this.resources, services: this.services }, () => session.start(input));
  }
  // Read-only: folds the durable log. When an identity exists (live, or persisted from a
  // prior life) the session resolves and caches like any other path. Only a read on a
  // NEVER-keyed object stays non-committal — caching there would bake "self" in as the
  // identity and 409 a later keyed turn — so it folds through an ephemeral AgentSession.
  transcript() {
    if (this.session) return this.session.transcript();
    if (this.store.getSessionKey() !== undefined) return this.resolveSession().transcript();
    return new AgentSession(this.name, "self", this.store, this.sink, this.model, this.tools, crossDoUnsupported, this.channelInstructions).transcript();
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
      // DELIVERED: like detach=1, the caller gets a 202 and goes away — but the reply is NOT
      // dropped: this DO renders the turn's event stream through the source channel's own
      // deliver() (the inbound renderer), under the DO's lifetime. Capability is checked
      // BEFORE the turn starts — that ordering is DeliverUnsupportedError's contract at the
      // surface: on a pre-start rejection the caller may fall back to consumer-side rendering
      // without double-running the turn.
      const wantsDeliver = url.searchParams.get("deliver") === "1";
      let deliverChannel: Channel | undefined;
      if (wantsDeliver) {
        if (!event?.channelId) {
          return Response.json({ error: "deliver=1 needs an inbound event (event.channelId names the reply target)" }, { status: 400 });
        }
        deliverChannel = this.channels.find((c) => c.name === event.source);
        if (!deliverChannel?.deliver) {
          return Response.json(
            { error: `agent "${this.name}": no deliver()-capable channel named "${event.source}" is wired into this DO (DoAgentDef.channels) — the turn was NOT started` },
            { status: 501 },
          );
        }
      }
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
      if (wantsDeliver) {
        // Subscribe synchronously (same guarantee sseTurnStream relies on: start() scheduled
        // the turn, no event can have emitted yet), then render under THIS DO's lifetime —
        // the retained promise is pending work that keeps the DO alive, so a long turn's
        // rendering survives however briefly the caller held its connection. The event is
        // present (checked above); its author/thread are the reply target, exactly the
        // surface the channel's inbound renderStream derives.
        //
        // Once start() has queued the turn, NOTHING here may escape: a throw would 500 the
        // caller for a turn that runs anyway — the exact ambiguity delivered turns exist to
        // remove. deliver() is app/third-party code that can throw synchronously before
        // returning its promise, so it is deferred into the chain (the eager subscription
        // above stays synchronous — that timing guarantee must not move); the try/catch
        // backstops the subscription itself. Rendering failures have no live consumer —
        // this log is their only surfacing path (the TURN's own failures already surface
        // via the #76 sink subscription).
        const logRenderFailure = (err: unknown) =>
          console.error(`[june] agent "${this.name}": delivered render for turn ${started.turnId} failed:`, err);
        try {
          const events = observeTurnEvents(session, started.turnId);
          const target = { channelId: event!.channelId, threadId: event!.threadId, recipientUserId: event!.user?.id, recipientTeamId: event!.teamId };
          Promise.resolve()
            .then(() => runInScope({ resources: this.resources, services: this.services }, () => deliverChannel!.deliver!(target, events, { session: this.sessionKey })))
            .catch(logRenderFailure);
        } catch (err) {
          logRenderFailure(err);
        }
        return Response.json({ turnId: started.turnId }, { status: 202 });
      }
      // DETACHED (#77): the turn is accepted — 202 now, no stream. It keeps running under
      // this DO's lifetime (alive while work is pending), so its duration is no longer
      // bounded by however long the CALLER can hold a connection (the edge waitUntil
      // ceiling). Nobody consumes the result; failures surface via the #76 log/hook.
      if (url.searchParams.get("detach") === "1") return Response.json({ turnId: started.turnId }, { status: 202 });
      return new Response(sseTurnStream(session, started.turnId), { headers: SSE_HEADERS });
    }
    // Provide the input a suspended turn is waiting on and stream its continuation as SSE.
    // NOTE: this default surface passes `by` straight from the body — the engine treats it as a
    // VERIFIED identity, so the app must authenticate it upstream (e.g. take the user id from a
    // signature-checked Slack interaction payload), never expose this endpoint raw to clients.
    if (req.method === "POST" && url.pathname.endsWith("/resume")) {
      const { turnId, inputId, input, by, source, target } = (await req.json()) as {
        turnId: string; inputId: string; input: unknown; by?: string;
        source?: string; target?: ResumeDeliveryTarget;
      };
      await ensureScope();
      // DELIVERED resume: like /turn?deliver=1, the caller 202s away and THIS DO renders the
      // continuation through the source channel's deliverResume() — a long continuation no
      // longer dies with the webhook isolate. Capability is checked BEFORE resume() applies
      // the answer — the DeliverUnsupportedError contract at the surface: on a pre-effect
      // refusal the caller may fall back to consumer-side rendering without double-answering
      // (a second resume of an already-applied input would 409).
      const wantsDeliver = url.searchParams.get("deliver") === "1";
      let resumeChannel: Channel | undefined;
      if (wantsDeliver) {
        if (!source || !target?.channelId || !target.messageTs) {
          return Response.json({ error: "resume deliver=1 needs `source` (the channel name) and `target` (channelId + messageTs of the prompt message)" }, { status: 400 });
        }
        resumeChannel = this.channels.find((c) => c.name === source);
        if (!resumeChannel?.deliverResume) {
          return Response.json(
            { error: `agent "${this.name}": no deliverResume()-capable channel named "${source}" is wired into this DO (DoAgentDef.channels) — the answer was NOT applied` },
            { status: 501 },
          );
        }
      }
      let session: AgentSession;
      try {
        session = this.resolveSession(key);
        runInScope({ resources: this.resources, services: this.services }, () => session.resume(turnId, inputId, input, { by }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 403: the resumer may not answer; 409: not suspended / wrong turn / wrong input id / key mismatch
        return Response.json({ error: message }, { status: err instanceof ResumeAuthorizationError ? 403 : 409 });
      }
      if (wantsDeliver) {
        // Same post-acceptance discipline as delivered turns: subscribe synchronously, render
        // under this DO's lifetime, and let NOTHING escape past the accepted resume — the log
        // is the render failure's only surfacing path (the TURN's own failures surface via
        // the #76 sink subscription).
        const logRenderFailure = (err: unknown) =>
          console.error(`[june] agent "${this.name}": delivered resume render for turn ${turnId} failed:`, err);
        try {
          const events = observeTurnEvents(session, turnId);
          Promise.resolve()
            .then(() => runInScope({ resources: this.resources, services: this.services }, () => resumeChannel!.deliverResume!(target!, events, { session: this.sessionKey })))
            .catch(logRenderFailure);
        } catch (err) {
          logRenderFailure(err);
        }
        return Response.json({ turnId }, { status: 202 });
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

// The IN-PROCESS sibling of sseTurnStream: one turn's TurnEvents as an AsyncIterable, for a
// consumer living in the SAME isolate as the session (a delivered render). Subscribes eagerly
// at call time — not at first iteration — so the sseTurnStream timing guarantee carries over
// (call this synchronously after start(), before any event can emit); events landing before
// the consumer catches up are buffered. Ends after the turn's terminal event (completed,
// failed, or input.requested — a park ends this stream; a later /resume is a new one), and an
// early consumer exit (for-await break/return) unsubscribes rather than buffering forever.
function observeTurnEvents(session: AgentSession, turnId: string): AsyncIterable<TurnEvent> {
  const queue: TurnEvent[] = [];
  let terminal = false;
  let notify: (() => void) | undefined;
  const unsub = session.observe((e) => {
    queue.push(e);
    if (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "input.requested") terminal = true;
    notify?.();
  }, { turnId });
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<TurnEvent>> {
          for (;;) {
            const e = queue.shift();
            if (e) return { value: e, done: false };
            if (terminal) { unsub(); return { value: undefined, done: true }; }
            await new Promise<void>((resolve) => { notify = resolve; });
            notify = undefined;
          }
        },
        async return(): Promise<IteratorResult<TurnEvent>> {
          unsub();
          terminal = true;
          queue.length = 0;
          return { value: undefined, done: true };
        },
      };
    },
  };
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
      if (e.type === "turn.failed") throw new Error(e.error.message, { cause: e.error }); // full TurnError rides along
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

// A session key rides an HTTP header (SESSION_HEADER) and the DO name (idFromName) —
// reject values that can't: CR/LF would be header injection, and Headers.set throws a
// bare TypeError on control/non-ASCII bytes, turning a bad client value into an opaque
// 500 deep inside durableFetch. Non-empty printable ASCII is the contract.
const SESSION_KEY_RE = /^[\x20-\x7E]+$/;
function assertSessionKey(session: string) {
  if (typeof session !== "string" || !SESSION_KEY_RE.test(session)) {
    throw new Error(`invalid session key ${JSON.stringify(session)} — a session key must be a non-empty printable-ASCII string (it rides an HTTP header and the DO name)`);
  }
}

// Worker-side routing: address a session's DO by (agent, session) and forward the
// request to it. `env.AGENT` is the DO namespace binding. The session key rides a
// header (not the body): one seam covers /turn, /resume, and /transcript without
// touching any body contract, and an older DO simply ignores it.
export function durableFetch(namespace: DurableObjectNamespace, agent: string, session: string, req: Request): Promise<Response> {
  assertSessionKey(session);
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
    // `session` is CLIENT input here — an un-headerable value must be a clear 400, not
    // the opaque 500 assertSessionKey would become this deep in the worker.
    if (session !== undefined) {
      try {
        assertSessionKey(session);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }
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
// The services bag, memoized per (env object, agentName).
//
// Why that key. `env` identity is what makes the memo survive: a worker builds
// the surface inside `fetch`, so the only thing stable across requests is the
// env object the host hands in — and NOT the provider function, which the
// documented shape (`services: (e) => makeServices(e)`) recreates on every
// fetch. But env alone is too coarse: two surfaces mounted in one worker over
// the same env would then share whichever bag was built first, making the
// result depend on mount order. `agentName` is the surface's own stable
// identity, so it partitions them. (One agent must therefore have ONE services
// provider — mounting the same agentName twice with different providers is
// incoherent and keeps the first bag.)
//
// Held in an isolateLocal so duplicate module instances (workspace symlinks)
// share one cache; the outer WeakMap is keyed by env so a host handing out
// fresh env objects gets fresh bags instead of a leak. A non-object env (tests
// passing a primitive) skips memoization rather than throwing.
function resolveServices(
  factory: ((env: unknown) => unknown) | undefined,
  env: unknown,
  agentName: string,
): unknown {
  if (!factory) return undefined;
  if (typeof env !== "object" || env === null) return factory(env);
  const cache = isolateLocal(
    "june.durableChannelSurface.services",
    () => new WeakMap<object, Map<string, unknown>>(),
  );
  let perAgent = cache.get(env);
  if (!perAgent) {
    perAgent = new Map<string, unknown>();
    cache.set(env, perAgent);
  }
  if (!perAgent.has(agentName)) perAgent.set(agentName, factory(env));
  return perAgent.get(agentName);
}

export function durableChannelSurface(
  getNamespace: () => DurableObjectNamespace | undefined,
  opts: {
    agentName: string;
    channels: (Channel | ChannelFactory)[];
    env: unknown;
    // The app's services factory — the SAME one AgentDurableObject uses — resolved HERE
    // (worker isolate) and exposed to channel hooks as ctx.services. Channel hooks run at
    // the edge, outside the DO, so they can't read the DO's ambient currentServices(); this
    // gives them the same DI bag.
    //
    // Called once per (env object, agentName) — NOT once per surface. A worker
    // typically constructs the surface inside `fetch` (env only exists inside an
    // invocation), so resolving per construction rebuilt every client on every
    // request and any cache the bag held could never hit. Memoizing on env
    // identity fixes that; see resolveServices above for why the key is env ×
    // agentName and not the provider function. Practical consequences: the
    // provider must be a function of `env` alone, it runs again whenever the
    // host hands in a different env object (a new isolate, or a test), and one
    // agentName must have one provider.
    services?: (env: unknown) => unknown;
    waitUntil?: (p: Promise<unknown>) => void;
  },
): (req: Request) => Promise<Response | null> {
  const resolved = opts.channels.map((c) => resolveChannel(c, opts.env));
  const ctx: ChannelContext = {
    // A minimal but complete AgentDefinition — channels only read ctx.agent.name; the
    // full def isn't present in the worker (tools/model live in the DO).
    agent: { name: opts.agentName, instructions: "", tools: [], skills: [], channels: [], connections: [] } satisfies AgentDefinition,
    services: resolveServices(opts.services, opts.env, opts.agentName),
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
    // FIRE-AND-FORGET (#77): POST /turn?detach=1 — the DO 202s once the turn is accepted
    // and runs it under its OWN lifetime. This is how a shadow/observe hook (onEvent →
    // assessment turn, reply dropped) escapes the edge waitUntil ceiling that killed
    // 24–38s turns in production: nothing holds the edge open while the turn runs.
    runDetached: async (message, o) => {
      const namespace = getNamespace();
      if (!namespace) throw new Error("durableChannelSurface: no Durable Object namespace bound (env.AGENT)");
      const res = await durableFetch(
        namespace,
        opts.agentName,
        o?.session ?? "default",
        new Request("https://do/turn?detach=1", { method: "POST", body: serializeTurn(message, o) }),
      );
      if (res.status !== 202) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`runDetached: turn was not accepted (status ${res.status}): ${detail}`);
      }
      return (await res.json()) as { turnId: string };
    },
    // DELIVERED: runDetached's reply-bearing sibling — the DO runs the turn AND renders its
    // reply through the source channel's deliver() under its OWN lifetime, so a reply-bearing
    // turn escapes the edge waitUntil ceiling exactly as a shadow turn does. A 501 means the
    // DO refused BEFORE starting the turn (the channel isn't wired there / has no deliver) —
    // surfaced as DeliverUnsupportedError, the one rejection a channel may answer with a
    // consumer-side rendering fallback without double-running the turn.
    runDelivered: async (message, o) => {
      const namespace = getNamespace();
      if (!namespace) throw new Error("durableChannelSurface: no Durable Object namespace bound (env.AGENT)");
      const res = await durableFetch(
        namespace,
        opts.agentName,
        o?.session ?? "default",
        new Request("https://do/turn?deliver=1", { method: "POST", body: serializeTurn(message, o) }),
      );
      if (res.status === 501) {
        throw new DeliverUnsupportedError(`runDelivered: ${((await res.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? "the turn host cannot deliver this turn"}`);
      }
      if (res.status !== 202) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`runDelivered: delivered turn was not accepted (status ${res.status}): ${detail}`);
      }
      return (await res.json()) as { turnId: string };
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
    // DELIVERED resume (runDelivered's sibling for the HITL leg): the DO applies the answer
    // AND renders the continuation through the source channel's deliverResume() under its
    // OWN lifetime. A 501 means the DO refused BEFORE applying the answer (channel not
    // wired there / no deliverResume) — surfaced as DeliverUnsupportedError, the one
    // rejection a channel may answer with a consumer-side fallback without double-answering.
    // Engine rejections (403 unauthorized clicker / 409 stale-or-double click) throw as
    // ordinary errors, mirroring what resumeStream's first pull would do.
    resumeDelivered: async (o) => {
      const namespace = getNamespace();
      if (!namespace) throw new Error("durableChannelSurface: no Durable Object namespace bound (env.AGENT)");
      const res = await durableFetch(
        namespace,
        opts.agentName,
        o.session ?? "default",
        new Request("https://do/resume?deliver=1", { method: "POST", body: serializeResume(o) }),
      );
      if (res.status === 501) {
        throw new DeliverUnsupportedError(`resumeDelivered: ${((await res.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? "the turn host cannot deliver this continuation"}`);
      }
      if (res.status !== 202) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`resumeDelivered: resume was not accepted (status ${res.status}): ${detail}`);
      }
      return (await res.json()) as { turnId: string };
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
function serializeResume(o: { turnId: string; inputId: string; input: unknown; by?: string; source?: string; target?: ResumeDeliveryTarget }): string {
  try {
    return JSON.stringify({ turnId: o.turnId, inputId: o.inputId, input: o.input, by: o.by, source: o.source, target: o.target });
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
