// The supervision contract (#297): its JSON Schema accepts what its types describe and
// rejects what they don't, and traceTurn folds a turn from the durable log.

import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import type { Msg } from "../src/agent-runtime";
import {
  SUPERVISE_CONTRACT_VERSION,
  SUPERVISE_SCHEMA_ID,
  isKnownInboxEvent,
  superviseSchema,
  traceTurn,
  type AnyInboxEvent,
  type Decision,
  type InboxEvent,
  type PendingAction,
  type PendingPage,
  type SuperviseError,
  type TurnTrace,
} from "../src/supervise";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(superviseSchema);
const valid = (type: string, value: unknown) => ajv.validate(`${SUPERVISE_SCHEMA_ID}#/$defs/${type}`, value);

const at = "2026-09-28T10:00:00.000Z";
const pending: PendingAction = {
  id: "p1",
  agent: "scout",
  session: "slack:C1:1.0",
  turnId: "t_01",
  inputId: "send",
  prompt: "Send the reply to Ada?",
  answerers: { policy: "operators", scope: { mailbox: "scout" } },
  action: { tool: "send_email", input: { to: "ada@example.com" }, callId: "c1" },
  origin: { source: "slack", kind: "app_mention", channelId: "C1", threadId: "1.0", user: { id: "U1", attested: true }, text: "reply to Ada" },
  queued: 0,
  parkedAt: at,
  status: "pending",
};

describe("the supervision contract's JSON Schema (#297)", () => {
  test("is versioned, and compiles under strict draft 2020-12", () => {
    expect(SUPERVISE_CONTRACT_VERSION).toBe(1);
    expect(SUPERVISE_SCHEMA_ID).toBe("urn:june:supervise:1");
    expect(ajv.getSchema(SUPERVISE_SCHEMA_ID)).toBeDefined();
  });

  test("accepts a pending action, and a resolved one", () => {
    expect(valid("PendingAction", pending)).toBe(true);
    const answered: PendingAction = { ...pending, status: "answered", resolution: { outcome: "answered", decision: "reject", by: "U2", at } };
    expect(valid("PendingAction", answered)).toBe(true);
    const minimal: PendingAction = { id: "p2", agent: "a", session: "s", turnId: "t", inputId: "i", prompt: "ok?", queued: 2, parkedAt: at, status: "pending" };
    expect(valid("PendingAction", minimal)).toBe(true);
  });

  test("rejects a resolved action without its resolution, and a pending one with it", () => {
    expect(valid("PendingAction", { ...pending, status: "retired" })).toBe(false);
    expect(valid("PendingAction", { ...pending, resolution: { outcome: "retired", at } })).toBe(false);
  });

  test("rejects wrong shapes", () => {
    expect(valid("PendingAction", { ...pending, queued: -1 })).toBe(false);
    expect(valid("PendingAction", { ...pending, parkedAt: "yesterday" })).toBe(false);
    expect(valid("PendingAction", { ...pending, parkedAt: "2026-02-30T10:00:00Z" })).toBe(false); // no such day
    expect(valid("PendingAction", { ...pending, status: "open" })).toBe(false);
    expect(valid("PendingAction", { ...pending, answerers: { team: "ops" } })).toBe(false);
    const { prompt: _, ...noPrompt } = pending;
    expect(valid("PendingAction", noPrompt)).toBe(false);
  });

  test("an origin never carries the principal or the platform payload", () => {
    const event = { source: "slack", kind: "message", channelId: "C1", ts: "1.0", principal: { id: "u_1" }, raw: {} };
    // @ts-expect-error — an InboundEvent is not a PendingOrigin
    const origin: PendingAction["origin"] = event;
    expect(valid("PendingAction", { ...pending, origin })).toBe(false);
    expect(valid("PendingAction", { ...pending, origin: { ...pending.origin, raw: {} } })).toBe(false);
    expect(valid("PendingAction", { ...pending, origin: { ...pending.origin, principal: { id: "u_1" } } })).toBe(false);
  });

  test("allows fields it does not know: additions keep the version", () => {
    expect(valid("PendingAction", { ...pending, priority: "high" })).toBe(true);
  });

  test("decisions", () => {
    const ok: Decision[] = [{ kind: "approve" }, { kind: "approve", input: { body: "edited" } }, { kind: "reject" }, { kind: "reject", note: "wrong tone" }];
    for (const d of ok) expect(valid("Decision", d)).toBe(true);
    expect(valid("Decision", { kind: "maybe" })).toBe(false);
    expect(valid("Decision", { kind: "reject", note: 3 })).toBe(false);
  });

  test("inbox events: known kinds are checked, an unknown kind passes", () => {
    const events: InboxEvent[] = [
      { kind: "pending.created", cursor: "1", at, pending },
      { kind: "pending.updated", cursor: "2", at, pendingId: "p1", queued: 1 },
      { kind: "pending.resolved", cursor: "3", at, pendingId: "p1", resolution: { outcome: "answered", decision: "approve", by: "u_1", at } },
    ];
    for (const e of events) expect(valid("InboxEvent", e)).toBe(true);
    expect(valid("InboxEvent", { kind: "pending.created", cursor: "1", at })).toBe(false);
    expect(valid("InboxEvent", { kind: "pending.resolved", cursor: "3", at, pendingId: "p1", resolution: { outcome: "lost", at } })).toBe(false);
    const future: AnyInboxEvent = { kind: "mail.received", cursor: "4", at, threadId: "th1" };
    expect(valid("InboxEvent", future)).toBe(true);
    // a client narrows to what it knows and skips the rest
    const seen = [...events, future].filter(isKnownInboxEvent).map((e) => (e.kind === "pending.created" ? e.pending.id : e.pendingId));
    expect(seen).toEqual(["p1", "p1", "p1"]);
  });

  test("a page, a trace, an error", () => {
    const page: PendingPage = { items: [pending], next: "c" };
    expect(valid("PendingPage", page)).toBe(true);
    const trace: TurnTrace = { agent: "a", session: "s", turnId: "t", prompt: "hi", steps: [{ callId: "c1", tool: "x", input: {}, status: "pending" }] };
    expect(valid("TurnTrace", trace)).toBe(true);
    expect(valid("TurnTrace", { ...trace, steps: [{ callId: "c1", tool: "x", input: {}, status: "running" }] })).toBe(false);
    const conflict: SuperviseError = { error: "already_resolved", message: "U2 approved it", resolution: { outcome: "answered", decision: "approve", by: "U2", at } };
    expect(valid("SuperviseError", conflict)).toBe(true);
    expect(valid("SuperviseError", { error: "already_resolved" })).toBe(false);
    const later: SuperviseError = { error: "rate_limited", message: "slow down" }; // a code added later
    expect(valid("SuperviseError", later)).toBe(true);
  });
});

describe("traceTurn (#297)", () => {
  const ids = { agent: "scout", session: "s1", turnId: "t_2" };
  const log: Msg[] = [
    { role: "user", turnId: "t_1", text: "earlier" },
    { role: "assistant", turnId: "t_1", text: "done", toolCalls: [] },
    { role: "user", turnId: "t_2", text: "reply to Ada" },
    { role: "assistant", turnId: "t_2", text: "Looking.", toolCalls: [{ id: "c1", name: "search", input: { q: "Ada" } }, { id: "c2", name: "flaky", input: {} }] },
    { role: "tool", turnId: "t_2", toolCallId: "c1", name: "search", result: { hits: 1 } },
    { role: "tool", turnId: "t_2", toolCallId: "c2", name: "flaky", result: { error: "boom" }, isError: true },
    { role: "note", turnId: "n_1", by: "op", kind: "observed", text: "fyi", at },
    { role: "assistant", turnId: "t_2", text: "", toolCalls: [{ id: "c3", name: "send_email", input: { to: "ada@example.com" } }] },
  ];

  test("folds the prompt, each call with its outcome, and the last words; the parked call is pending", () => {
    expect(traceTurn(log, ids)).toEqual({
      ...ids,
      prompt: "reply to Ada",
      text: "Looking.",
      steps: [
        { callId: "c1", tool: "search", input: { q: "Ada" }, status: "done", result: { hits: 1 } },
        { callId: "c2", tool: "flaky", input: {}, status: "error", result: { error: "boom" } },
        { callId: "c3", tool: "send_email", input: { to: "ada@example.com" }, status: "pending" },
      ],
    });
  });

  test("a proactive turn keeps who seeded it; an unknown turn is undefined", () => {
    const seeded: Msg[] = [{ role: "trigger", turnId: "t_3", text: "daily digest", by: "cron:daily" }];
    expect(traceTurn(seeded, { ...ids, turnId: "t_3" })).toEqual({ ...ids, turnId: "t_3", prompt: "daily digest", by: "cron:daily", steps: [] });
    expect(traceTurn(log, { ...ids, turnId: "t_9" })).toBeUndefined();
  });

  test("its output satisfies the schema", () => {
    expect(valid("TurnTrace", traceTurn(log, ids))).toBe(true);
  });
});
