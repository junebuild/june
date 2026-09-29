// The agent supervision contract (#297, docs/rfc-email.md §9.1): what an operator surface —
// the `june inbox` CLI, a TUI, a web page, a coding agent — reads and sends to supervise an
// agent: the inputs parked waiting on a person, the turns behind them, and the decisions that
// answer them. Channel-neutral: a Slack approval and an email draft are the same PendingAction
// with a different origin; the email layer (Mailbox / Thread / Message) builds on top.
//
// Types, their JSON Schema, and one pure fold — no host code, so core stays pure.
// @junejs/server implements the contract (the pending-actions index and the supervision API).
//
// Versioning: SUPERVISE_CONTRACT_VERSION changes only on a breaking change. Additions — a new
// optional field, a new InboxEvent kind, a new error code — keep the version, so a client
// must ignore fields and event kinds it does not know, and treat an unknown error code by its
// HTTP status (the schemas allow all three; AnyInboxEvent and SuperviseError type them). The
// closed sets — a PendingAction's status, a Resolution's outcome and decision, a Decision's
// kind, Answerers — are closed on purpose: a client cannot safely act on a value it does not
// know there, so adding one is a breaking change.

import type { Answerers, Msg } from "./agent-runtime";

export const SUPERVISE_CONTRACT_VERSION = 1;

// Where the turn that parked came from: the inbound event that started it, trimmed to what an
// approver needs to judge the request. Never the platform payload (`raw`) or the resolved
// principal: both are forbidden here and in the schema, so an InboundEvent passed as is fails
// to type-check. Absent for a turn with no inbound event — proactive, or started through the API.
export type PendingOrigin = {
  source: string;       // the channel ("slack", "email", …)
  kind: string;         // the event kind ("message", "app_mention", …)
  channelId: string;
  threadId?: string;
  user?: { id: string; name?: string; attested?: boolean };
  text?: string;
  principal?: never;
  raw?: never;
};

// How a pending action ended. `answered` covers both an approval and a rejection — the engine
// hands the tool an answer either way; `decision` says which, when the resolving surface knows
// (a supervision API call, a Slack Approve / Deny click). `retired`: a session reset dropped it.
// `by` is the resolver's verified id: a platform user id, or the principal id of an API caller.
export type Resolution = {
  outcome: "answered" | "retired";
  decision?: Decision["kind"];
  by?: string;
  at: string;
};

// An input a turn parked on, waiting for a person (a `requestInput`). One per park: a turn
// that parks again after its answer yields a new PendingAction with a new id.
export type PendingAction = {
  id: string;           // opaque, unique per park; the handle every decision names
  agent: string;
  session: string;
  turnId: string;
  inputId: string;      // the request's id within the turn (InputRequest.id)
  prompt: string;       // what the tool asks the person
  schema?: unknown;     // the answer's shape (JSON Schema), when the tool gave one
  answerers?: Answerers; // who may answer — absent: no restriction (see Answerers)
  // The tool call that parked: what the agent wants to do, with the input it wants to do it with.
  action?: { tool: string; input: unknown; callId: string };
  origin?: PendingOrigin;
  queued: number;       // inbound turns held behind the park since it was made: the conversation moved on
  parkedAt: string;     // ISO 8601
  status: "pending" | "answered" | "retired";
  resolution?: Resolution; // set once status is not "pending"
};

// What an operator sends to answer a pending action. The tool that parked receives:
//   approve — `input` when given (an approval with edits, or an answer matching the request's
//             schema), else `true`;
//   reject  — `false`; `note`, when given, joins the session's history as an attributed
//             operator note (the model reads why), right after the tool's answer.
export type Decision =
  | { kind: "approve"; input?: unknown }
  | { kind: "reject"; note?: string };

// One turn as an approver reads it: the prompt, each tool call and its outcome, the reply —
// folded from the durable log (traceTurn), so every host shows the same thing.
export type TraceStep = {
  callId: string;
  tool: string;
  input: unknown;
  status: "done" | "error" | "pending"; // pending: not answered yet (the call that parked, or one in flight)
  result?: unknown;
};
export type TurnTrace = {
  agent: string;
  session: string;
  turnId: string;
  prompt: string;       // the inbound text, or a proactive turn's seed
  by?: string;          // set when the turn was agent-initiated: who seeded it
  steps: TraceStep[];
  text?: string;        // the agent's last words in the turn
};

// A page of pending actions, newest first. `next` continues the listing; absent on the last page.
export type PendingPage = { items: PendingAction[]; next?: string };

// The change feed: what changed, in order. `cursor` resumes the feed after this event.
// InboxEvent is what this version defines; a client reads AnyInboxEvent — kinds are
// open-ended (see Versioning) — and skips what isKnownInboxEvent rejects.
export type InboxEvent =
  | { kind: "pending.created"; cursor: string; at: string; pending: PendingAction }
  | { kind: "pending.updated"; cursor: string; at: string; pendingId: string; queued: number }
  | { kind: "pending.resolved"; cursor: string; at: string; pendingId: string; resolution: Resolution };
export type AnyInboxEvent = InboxEvent | { kind: string; cursor: string; at: string; [field: string]: unknown };
const INBOX_EVENT_KINDS: ReadonlySet<string> = new Set<InboxEvent["kind"]>(["pending.created", "pending.updated", "pending.resolved"]);
// Narrows to the kinds this version defines (a string `kind` in the union would stop a plain
// `e.kind === …` check from narrowing).
export function isKnownInboxEvent(e: AnyInboxEvent): e is InboxEvent {
  return INBOX_EVENT_KINDS.has(e.kind);
}

// The error body of every supervision call. `already_resolved` (HTTP 409) carries the
// resolution, so the loser of a race learns who decided and when.
export type SuperviseError = {
  error: "unauthorized" | "forbidden" | "not_found" | "already_resolved" | "invalid" | (string & {});
  message: string;
  resolution?: Resolution;
};

// ── the fold ───────────────────────────────────────────────────────────────────
// The trace of `turnId` from a session's log, or undefined when the log has no such turn.
// A step whose result is not in the log yet is "pending".
export function traceTurn(msgs: Msg[], ids: { agent: string; session: string; turnId: string }): TurnTrace | undefined {
  let trace: TurnTrace | undefined;
  const steps = new Map<string, TraceStep>();
  for (const m of msgs) {
    if (m.turnId !== ids.turnId) continue;
    trace ??= { ...ids, prompt: "", steps: [] };
    if (m.role === "user") trace.prompt = m.text;
    else if (m.role === "trigger") { trace.prompt = m.text; trace.by = m.by; }
    else if (m.role === "assistant") {
      if (m.text) trace.text = m.text;
      for (const c of m.toolCalls) {
        const step: TraceStep = { callId: c.id, tool: c.name, input: c.input, status: "pending" };
        steps.set(c.id, step);
        trace.steps.push(step);
      }
    } else if (m.role === "tool") {
      const step = steps.get(m.toolCallId);
      if (step) { step.status = m.isError ? "error" : "done"; step.result = m.result; }
    }
  }
  return trace;
}

// ── JSON Schema (draft 2020-12) ────────────────────────────────────────────────
// One document; each type is a $defs entry, addressed as `${SUPERVISE_SCHEMA_ID}#/$defs/<Type>`.
// For clients in other languages, and for validating what crosses the wire.
export const SUPERVISE_SCHEMA_ID = `urn:june:supervise:${SUPERVISE_CONTRACT_VERSION}`;

const str = { type: "string" } as const;
const time = { type: "string", format: "date-time" } as const;
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });

export const superviseSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SUPERVISE_SCHEMA_ID,
  title: "June agent supervision contract",
  $defs: {
    Answerers: {
      oneOf: [
        { type: "object", required: ["user"], properties: { user: str } },
        { type: "object", required: ["policy"], properties: { policy: str, scope: {} } },
      ],
    },
    PendingOrigin: {
      type: "object",
      required: ["source", "kind", "channelId"],
      properties: {
        source: str,
        kind: str,
        channelId: str,
        threadId: str,
        user: { type: "object", required: ["id"], properties: { id: str, name: str, attested: { type: "boolean" } } },
        text: str,
        principal: false,
        raw: false,
      },
    },
    Resolution: {
      type: "object",
      required: ["outcome", "at"],
      properties: {
        outcome: { enum: ["answered", "retired"] },
        decision: { enum: ["approve", "reject"] },
        by: str,
        at: time,
      },
    },
    PendingAction: {
      type: "object",
      required: ["id", "agent", "session", "turnId", "inputId", "prompt", "queued", "parkedAt", "status"],
      properties: {
        id: str,
        agent: str,
        session: str,
        turnId: str,
        inputId: str,
        prompt: str,
        schema: {},
        answerers: ref("Answerers"),
        action: { type: "object", required: ["tool", "input", "callId"], properties: { tool: str, input: {}, callId: str } },
        origin: ref("PendingOrigin"),
        queued: { type: "integer", minimum: 0 },
        parkedAt: time,
        status: { enum: ["pending", "answered", "retired"] },
        resolution: ref("Resolution"),
      },
      // A resolved action says how; a pending one has not been resolved.
      if: { properties: { status: { const: "pending" } } },
      then: { properties: { resolution: false } },
      else: { required: ["resolution"] },
    },
    Decision: {
      oneOf: [
        { type: "object", required: ["kind"], properties: { kind: { const: "approve" }, input: {} } },
        { type: "object", required: ["kind"], properties: { kind: { const: "reject" }, note: str } },
      ],
    },
    TraceStep: {
      type: "object",
      required: ["callId", "tool", "input", "status"],
      properties: { callId: str, tool: str, input: {}, status: { enum: ["done", "error", "pending"] }, result: {} },
    },
    TurnTrace: {
      type: "object",
      required: ["agent", "session", "turnId", "prompt", "steps"],
      properties: { agent: str, session: str, turnId: str, prompt: str, by: str, steps: { type: "array", items: ref("TraceStep") }, text: str },
    },
    PendingPage: {
      type: "object",
      required: ["items"],
      properties: { items: { type: "array", items: ref("PendingAction") }, next: str },
    },
    // Known kinds are checked; an unknown kind passes (see Versioning).
    InboxEvent: {
      type: "object",
      required: ["kind", "cursor", "at"],
      properties: { kind: str, cursor: str, at: time },
      allOf: [
        {
          if: { properties: { kind: { const: "pending.created" } } },
          then: { required: ["pending"], properties: { pending: ref("PendingAction") } },
        },
        {
          if: { properties: { kind: { const: "pending.updated" } } },
          then: { required: ["pendingId", "queued"], properties: { pendingId: str, queued: { type: "integer", minimum: 0 } } },
        },
        {
          if: { properties: { kind: { const: "pending.resolved" } } },
          then: { required: ["pendingId", "resolution"], properties: { pendingId: str, resolution: ref("Resolution") } },
        },
      ],
    },
    SuperviseError: {
      type: "object",
      required: ["error", "message"],
      // Open-ended like event kinds: a client treats an unknown code by its HTTP status.
      properties: { error: str, message: str, resolution: ref("Resolution") },
    },
  },
} as const;
