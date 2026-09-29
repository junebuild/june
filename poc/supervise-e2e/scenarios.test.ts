// POC scenarios for the supervision API (#297): a real NativeRuntime parks turns, the index is
// fed by input announcements, and an operator drives /_june/inbox/v1 with a June token.
// Each test pins one requirement; the ones that FAIL today are the findings (README.md).
//   bun test poc/supervise-e2e

import { beforeEach, describe, expect, test } from "bun:test";

import type { InboundEvent, Model, ModelDelta, Msg, Tool } from "../../packages/core/src/agent-runtime";
import type { PendingAction, PendingPage, TurnTrace } from "../../packages/core/src/supervise";
import { createNativeRuntime, type NativeRuntime } from "../../packages/june/src/agent-native";

import { PendingIndex, sessionMessages, superviseHandler, type Authorize } from "./src/supervise";
import { issueToken } from "./src/token";

const SECRET = "poc-secret-0123456789abcdef0123456789";
const OPERATORS = new Set(["op:ada"]);

// The model asks to send a reply (the tool parks for approval), then reports what it got.
// Every model call's input is kept, to check what the model read after a decision.
const seen: Msg[][] = [];
const model: Model = (msgs) =>
  (async function* (): AsyncGenerator<ModelDelta> {
    seen.push(msgs);
    const last = msgs.findLast((m) => m.role === "tool");
    if (!last) {
      const answerers = msgs.find((m) => m.role === "user")?.text.includes("policy") ? { policy: "operators" } : undefined;
      yield { type: "done", reply: { text: "Drafting.", toolCalls: [{ id: "c1", name: "send_reply", input: { to: "grace@example.com", body: "Hi Grace", answerers } }] } };
      return;
    }
    yield { type: "done", reply: { text: `result: ${JSON.stringify(last.result)}`, toolCalls: [] } };
  })();
const sendReply: Tool = {
  spec: { name: "send_reply", description: "send a reply", input: { type: "object" } },
  run: async (input, ctx) => {
    const { to, answerers } = input as { to: string; answerers?: { policy: string } };
    const answer = await ctx.requestInput({ id: "send", prompt: `Send the reply to ${to}?`, ...(answerers ? { answerers } : {}) });
    return { sent: answer !== false, answer };
  },
};

// A Slack-shaped inbound event: the platform attests the speaker.
const slack = (text: string, thread: string): InboundEvent => ({ source: "slack", kind: "app_mention", channelId: "C1", threadId: thread, ts: thread, user: { id: "U_GRACE", name: "grace", attested: true }, text });

let rt: NativeRuntime;
let index: PendingIndex;
let handle: (req: Request) => Promise<Response | undefined>;
const authorize: Authorize = ({ principal, action }) => (action === "read" ? principal.id.startsWith("op:") : OPERATORS.has(principal.id));

beforeEach(async () => {
  seen.length = 0;
  index = new PendingIndex();
  rt = await createNativeRuntime({
    scout: {
      model,
      tools: [sendReply],
      onInputAnnouncement: (a) => index.apply(a, () => sessionMessages(rt.session(a.agent, a.session))),
    },
  });
  handle = superviseHandler({
    secret: SECRET,
    index,
    session: (agent, id) => rt.session(agent, id),
    authorize,
    authorizeAnswer: ({ policy, principal }) => policy === "operators" && !!principal && OPERATORS.has(principal.id),
  });
});

const token = (sub: string, scopes = ["inbox:read", "inbox:decide"], ttlSeconds = 600) => issueToken(SECRET, { sub, scopes, ttlSeconds });
async function call(method: string, path: string, tok?: string, body?: unknown) {
  const res = (await handle(new Request(`http://app.test/_june/inbox/v1${path}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })))!;
  return { status: res.status, body: (await res.json()) as any };
}
async function park(session: string, text: string): Promise<PendingAction> {
  const s = rt.session("scout", session);
  const { turnId } = s.start({ userText: text, event: slack(text, session) });
  await s.result(turnId);
  await s.flushAnnouncements();
  return index.list("pending").find((p) => p.session === session)!;
}

describe("supervision POC (#297)", () => {
  test("a park appears in the index with what the agent wants to do and where it came from", async () => {
    const p = await park("s1", "reply to grace (policy)");
    const { status, body } = await call("GET", "/pending", await token("op:ada"));
    expect(status).toBe(200);
    expect((body as PendingPage).items.map((i) => i.id)).toEqual([p.id]);
    expect(p).toMatchObject({
      agent: "scout", inputId: "send", prompt: "Send the reply to grace@example.com?", status: "pending", queued: 0,
      answerers: { policy: "operators" },
      action: { tool: "send_reply", input: { to: "grace@example.com", body: "Hi Grace" }, callId: "c1" },
      origin: { source: "slack", kind: "app_mention", channelId: "C1", user: { id: "U_GRACE", attested: true } },
    });
    const shown = await call("GET", `/pending/${p.id}`, await token("op:ada"));
    expect((shown.body.trace as TurnTrace).steps).toEqual([{ callId: "c1", tool: "send_reply", input: expect.any(Object), status: "pending" }]);
  });

  test("approve a { policy } park: the turn resumes with true, the action is resolved and attributed", async () => {
    const p = await park("s2", "reply to grace (policy)");
    const r = await call("POST", `/pending/${p.id}/decision`, await token("op:ada"), { kind: "approve" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "answered", resolution: { outcome: "answered", decision: "approve", by: "op:ada" } });
    await rt.session("scout", "s2").result(p.turnId);
    expect(seen.at(-1)!.findLast((m) => m.role === "tool")).toMatchObject({ result: { sent: true, answer: true } });
  });

  test("the loser of a race gets 409 naming who decided", async () => {
    const p = await park("s3", "reply to grace (policy)");
    const tok = await token("op:ada");
    const [a, b] = await Promise.all([
      call("POST", `/pending/${p.id}/decision`, tok, { kind: "approve" }),
      call("POST", `/pending/${p.id}/decision`, tok, { kind: "reject" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(lost.body).toMatchObject({ error: "already_resolved", resolution: { by: "op:ada" } });
  });

  test("reject with a note: the tool gets false, and the model reads the note right after the tool's answer", async () => {
    const p = await park("s4", "reply to grace (policy)");
    const r = await call("POST", `/pending/${p.id}/decision`, await token("op:ada"), { kind: "reject", note: "Wrong tone, don't send." });
    expect(r.status).toBe(200);
    await rt.session("scout", "s4").result(p.turnId);
    const last = seen.at(-1)!;
    const at = last.findIndex((m) => m.role === "tool");
    expect(last[at]).toMatchObject({ result: { sent: false, answer: false } });
    expect(last[at + 1]).toMatchObject({ role: "note", by: "op:ada", kind: "operator_reply", text: "Wrong tone, don't send." });
  });

  test("an inbound message held behind the park bumps `queued`", async () => {
    const p = await park("s5", "reply to grace (policy)");
    const s = rt.session("scout", "s5");
    s.start({ userText: "also cc Alan", event: slack("also cc Alan", "s5"), ifSuspended: "queue" });
    await s.flushAnnouncements();
    expect(index.get(p.id)!.queued).toBe(1);
  });

  test("tokens: missing, forged, expired, wrong alg → 401; missing scope → 403; authorize unset or refusing → 404/403", async () => {
    const p = await park("s6", "reply to grace (policy)");
    expect((await call("GET", "/pending")).status).toBe(401);
    const good = await token("op:ada");
    const forged = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
    expect((await call("GET", "/pending", forged)).status).toBe(401);
    expect((await call("GET", "/pending", await issueToken(SECRET, { sub: "op:ada", scopes: ["inbox:read"], ttlSeconds: 60, now: Date.now() - 3_600_000 }))).status).toBe(401);
    const [, payload] = good.split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
    expect((await call("GET", "/pending", none)).status).toBe(401);
    expect((await call("POST", `/pending/${p.id}/decision`, await token("op:ada", ["inbox:read"]), { kind: "approve" })).status).toBe(403);
    // read-only operator: sees it, may not decide
    expect((await call("GET", `/pending/${p.id}`, await token("op:bob"))).status).toBe(200);
    expect((await call("POST", `/pending/${p.id}/decision`, await token("op:bob"), { kind: "approve" })).status).toBe(403);
    // not an operator: the action does not exist for them
    expect((await call("GET", `/pending/${p.id}`, await token("u:mallory"))).status).toBe(404);
    expect((await call("GET", "/pending", await token("u:mallory"))).body.items).toEqual([]);
  });

  // FINDING F1: an ordinary Slack park names the Slack user as its answerer ({ user: "U_GRACE" }),
  // and the engine compares the resumer's `by` to that id verbatim. An operator authenticated
  // by a June principal ("op:ada") can never answer it — only the Slack button can.
  test("F1: an operator cannot answer an ordinary Slack park (default answerer = the Slack user)", async () => {
    const p = await park("s7", "reply to grace");
    expect(p.answerers).toEqual({ user: "U_GRACE" });
    const r = await call("POST", `/pending/${p.id}/decision`, await token("op:ada"), { kind: "approve" });
    expect(r.status).toBe(403);
  });
});
