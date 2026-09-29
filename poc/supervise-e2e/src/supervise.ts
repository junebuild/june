// The supervision side of the POC (#297): a pending-actions index fed by input announcements,
// and the /_june/inbox/v1 routes over it. Native only: the index lives in its own SQLite here;
// the real thing would share the runtime's database (NativeRuntime keeps its handle private).

import { Database } from "bun:sqlite";

import {
  grantAnswer,
  ResumeAuthorizationError,
  type AgentSession,
  type AuthorizeAnswer,
  type InputAnnouncement,
  type Msg,
} from "../../../packages/core/src/agent-runtime";
import { traceTurn, type Decision, type PendingAction, type Resolution, type SuperviseError } from "../../../packages/core/src/supervise";

import { verifyToken, type TokenPrincipal } from "./token";

// ── the authorize hook (decided 2026-09-28: new, fails closed) ────────────────
export type Authorize = (a: { principal: TokenPrincipal; agent: string; action: "read" | "decide"; pending: PendingAction }) => boolean | Promise<boolean>;

// ── the index ─────────────────────────────────────────────────────────────────
export class PendingIndex {
  readonly db = new Database(":memory:");
  constructor() {
    this.db.run(`CREATE TABLE pending_actions (id TEXT PRIMARY KEY, agent TEXT, session TEXT, turn_id TEXT, input_id TEXT, status TEXT, parked_at TEXT, body TEXT)`);
    this.db.run(`CREATE TABLE seen_announcements (id TEXT PRIMARY KEY)`);
    // What this API decided, so the resolved announcement (which only says "answered") can say how.
    this.db.run(`CREATE TABLE decisions (pending_id TEXT PRIMARY KEY, kind TEXT)`);
  }

  // `messages` reads the session's log, for the parked tool call. AgentSession has no public
  // accessor for its messages — the POC reaches into the store (finding F4).
  apply(a: InputAnnouncement, messages: () => Msg[]): void {
    const fresh = this.db.query(`INSERT OR IGNORE INTO seen_announcements VALUES (?)`).run(a.id).changes === 1;
    if (!fresh) return; // at-least-once delivery: dedupe on the announcement id
    if (a.kind === "parked") {
      const trace = traceTurn(messages(), { agent: a.agent, session: a.session, turnId: a.turnId });
      const call = trace?.steps.findLast((s) => s.status === "pending");
      const e = a.event;
      const p: PendingAction = {
        id: a.id,
        agent: a.agent,
        session: a.session,
        turnId: a.turnId,
        inputId: a.request.id,
        prompt: a.request.prompt,
        ...(a.request.schema !== undefined ? { schema: a.request.schema } : {}),
        ...(a.request.answerers ? { answerers: a.request.answerers } : {}),
        ...(call ? { action: { tool: call.tool, input: call.input, callId: call.callId } } : {}),
        ...(e ? { origin: { source: e.source, kind: e.kind, channelId: e.channelId, ...(e.threadId ? { threadId: e.threadId } : {}), ...(e.user ? { user: { id: e.user.id, ...(e.user.name ? { name: e.user.name } : {}), ...(e.user.attested ? { attested: true } : {}) } } : {}), ...(e.text ? { text: e.text } : {}) } } : {}),
        queued: a.queued,
        parkedAt: a.at,
        status: "pending",
      };
      this.db.query(`INSERT INTO pending_actions VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(p.id, p.agent, p.session, p.turnId, p.inputId, p.parkedAt, JSON.stringify(p));
      return;
    }
    const row = this.db.query(`SELECT body FROM pending_actions WHERE agent = ? AND session = ? AND turn_id = ? AND input_id = ? AND status = 'pending'`).get(a.agent, a.session, a.turnId, a.inputId) as { body: string } | null;
    if (!row) return;
    const p = JSON.parse(row.body) as PendingAction;
    if (a.kind === "held") p.queued = a.queued;
    else {
      const decided = this.db.query(`SELECT kind FROM decisions WHERE pending_id = ?`).get(p.id) as { kind: Decision["kind"] } | null;
      p.status = a.outcome;
      p.resolution = { outcome: a.outcome, ...(decided ? { decision: decided.kind } : {}), ...(a.by ? { by: a.by } : {}), at: a.at };
    }
    this.db.query(`UPDATE pending_actions SET status = ?, body = ? WHERE id = ?`).run(p.status, JSON.stringify(p), p.id);
  }

  get(id: string): PendingAction | undefined {
    const row = this.db.query(`SELECT body FROM pending_actions WHERE id = ?`).get(id) as { body: string } | null;
    return row ? (JSON.parse(row.body) as PendingAction) : undefined;
  }
  list(status: string): PendingAction[] {
    return (this.db.query(`SELECT body FROM pending_actions WHERE status = ? ORDER BY parked_at DESC, id`).all(status) as { body: string }[]).map((r) => JSON.parse(r.body));
  }
  markDecision(id: string, kind: Decision["kind"]) {
    this.db.query(`INSERT OR REPLACE INTO decisions VALUES (?, ?)`).run(id, kind);
  }
}

// ── the routes ────────────────────────────────────────────────────────────────
export type SuperviseHost = {
  secret: string;
  index: PendingIndex;
  session: (agent: string, id: string) => AgentSession;
  authorize?: Authorize;
  authorizeAnswer?: AuthorizeAnswer;
};

const BASE = "/_june/inbox/v1";
const err = (status: number, body: SuperviseError) => Response.json(body, { status });

export function superviseHandler(host: SuperviseHost) {
  const allowed = async (principal: TokenPrincipal, action: "read" | "decide", p: PendingAction) =>
    host.authorize ? (await host.authorize({ principal, agent: p.agent, action, pending: p })) === true : false; // unset → deny

  return async (req: Request): Promise<Response | undefined> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(`${BASE}/`)) return undefined;
    const auth = req.headers.get("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m) return err(401, { error: "unauthorized", message: "a bearer token is required" });
    const v = await verifyToken(host.secret, m[1]!);
    if (!v.ok) return err(401, { error: "unauthorized", message: `token rejected: ${v.reason}` });
    const principal = v.principal;
    const need = (scope: string) => (principal.scopes.includes(scope) ? undefined : err(403, { error: "forbidden", message: `this token lacks the ${scope} scope` }));

    const path = url.pathname.slice(BASE.length);
    if (req.method === "GET" && path === "/pending") {
      const denied = need("inbox:read");
      if (denied) return denied;
      const items: PendingAction[] = [];
      for (const p of host.index.list(url.searchParams.get("status") ?? "pending")) if (await allowed(principal, "read", p)) items.push(p);
      return Response.json({ items });
    }
    const one = /^\/pending\/([^/]+)(\/decision)?$/.exec(path);
    if (!one) return err(404, { error: "not_found", message: `no route ${req.method} ${url.pathname}` });
    const denied = need(one[2] ? "inbox:decide" : "inbox:read");
    if (denied) return denied;
    const p = host.index.get(decodeURIComponent(one[1]!));
    // Unreadable reads as missing: a principal learns nothing about another mailbox's actions.
    if (!p || !(await allowed(principal, "read", p))) return err(404, { error: "not_found", message: "no such pending action" });

    if (req.method === "GET" && !one[2]) {
      const s = host.session(p.agent, p.session);
      const trace = traceTurn(sessionMessages(s), { agent: p.agent, session: p.session, turnId: p.turnId });
      return Response.json({ pending: p, trace });
    }
    if (req.method !== "POST" || !one[2]) return err(404, { error: "not_found", message: `no route ${req.method} ${url.pathname}` });

    if (!(await allowed(principal, "decide", p))) return err(403, { error: "forbidden", message: `${principal.id} may not decide on this action` });
    if (p.status !== "pending") return err(409, { error: "already_resolved", message: resolvedMessage(p.resolution!), resolution: p.resolution });
    const decision = (await req.json().catch(() => undefined)) as Decision | undefined;
    if (!decision || (decision.kind !== "approve" && decision.kind !== "reject")) return err(400, { error: "invalid", message: "the body must be a Decision" });

    const s = host.session(p.agent, p.session);
    const by = principal.id;
    const granted = await grantAnswer(s, { turnId: p.turnId, inputId: p.inputId, by, principal }, host.authorizeAnswer);
    // A reject's note must reach the log only if the answer is accepted, and before the resumed
    // turn next asks the model. The engine has no atomic resume-with-note (finding F3), so the
    // POC pre-checks the engine's rule, queues the note (held while the tool result is owed),
    // then resumes.
    const answerers = s.pending()?.request.answerers;
    const wouldAccept = !answerers || ("user" in answerers ? answerers.user === by : granted !== undefined);
    if (!wouldAccept) return err(403, { error: "forbidden", message: `${by} is not an answerer of this input (${JSON.stringify(answerers)})` });
    host.index.markDecision(p.id, decision.kind);
    if (decision.kind === "reject" && decision.note) await s.note({ by, kind: "operator_reply", text: decision.note });
    try {
      s.resume(p.turnId, p.inputId, decision.kind === "approve" ? (decision.input ?? true) : false, { by, granted });
    } catch (e) {
      await s.flushAnnouncements();
      const now = host.index.get(p.id)!;
      if (e instanceof ResumeAuthorizationError) return err(403, { error: "forbidden", message: e.message });
      // Lost a race: another surface answered between our check and the resume.
      if (now.status !== "pending") return err(409, { error: "already_resolved", message: resolvedMessage(now.resolution!), resolution: now.resolution });
      return err(409, { error: "already_resolved", message: String(e) });
    }
    await s.flushAnnouncements();
    return Response.json(host.index.get(p.id));
  };
}

function resolvedMessage(r: Resolution): string {
  return r.outcome === "retired" ? `retired by a session reset at ${r.at}` : `already ${r.decision ? `${r.decision}d` : "answered"} by ${r.by ?? "someone"} at ${r.at}`;
}

// Finding F4: no public accessor for a session's log.
export function sessionMessages(s: AgentSession): Msg[] {
  return (s as unknown as { store: { messages(): Msg[] } }).store.messages();
}
