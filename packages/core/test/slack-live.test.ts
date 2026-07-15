// LIVE Slack contract check (opt-in). The unit suite stubs fetch — it proves OUR logic, not
// that api.slack.com still accepts our requests. This suite actually calls Slack, so it runs
// only when pointed at a throwaway test workspace + channel:
//
//   SLACK_LIVE_BOT_TOKEN=xoxb-… SLACK_LIVE_CHANNEL=C… bun test slack-live
//
// Needs a bot with chat:write (and channels:history to read the result back — tolerated if
// missing) that is a member of the channel. Each run posts a root message and streams one
// short reply into its thread. `stopped_by_user` can't be automated (a human must click
// Stop in the Slack UI) — that path stays covered by the stubbed unit tests.

import { describe, expect, test } from "bun:test";

const token = process.env.SLACK_LIVE_BOT_TOKEN;
const channel = process.env.SLACK_LIVE_CHANNEL;

type Reply = { ok: boolean; error?: string; ts?: string; messages?: { ts?: string; text?: string }[] };
async function slack(method: string, body: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Reply;
}
async function slackGet(method: string, params: Record<string, string>): Promise<Reply> {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Reply;
}
// Every ok-assert reports Slack's error CODE on failure — "expected true, got false"
// tells you nothing; "chat.postMessage failed: not_in_channel" tells you the fix.
function expectOk(r: Reply, what: string) {
  if (!r.ok) throw new Error(`${what} failed: ${r.error ?? "no error code"}`);
}
// Channel streams require recipient_user_id + recipient_team_id even in-thread (verified live
// 2026-07-15: missing_recipient_team_id) — use the bot's own identity from auth.test, cached.
type Ident = Reply & { user_id?: string; team_id?: string };
let ident: Promise<Ident> | undefined;
const whoami = () => (ident ??= slack("auth.test", {}) as Promise<Ident>);

describe.skipIf(!token || !channel)("slack live: the chat.startStream contract", () => {
  test("preflight: the token authenticates and the bot can use the channel", async () => {
    const auth = await slack("auth.test", {});
    if (!auth.ok) throw new Error(`auth.test failed: ${auth.error} — is SLACK_LIVE_BOT_TOKEN a valid xoxb-… bot token?`);
    const info = (await slackGet("conversations.info", { channel: channel! })) as Reply & { channel?: { is_member?: boolean } };
    // membership check is best-effort: conversations.info needs channels:read, which the
    // suite itself doesn't — a missing_scope here must not fail an otherwise usable token
    if (!info.ok && info.error !== "missing_scope") throw new Error(`conversations.info failed: ${info.error} — is SLACK_LIVE_CHANNEL the right C… id (and visible to this app)?`);
    if (info.ok && info.channel?.is_member === false) throw new Error(`the bot is not a member of ${channel} — run /invite @your-bot in that channel first`);
  }, 30_000);

  test("start → append → stop lands ONE streamed message holding the full text", async () => {
    const me = await whoami();
    const root = await slack("chat.postMessage", { channel, text: "june live-check root" });
    expectOk(root, "chat.postMessage (root)");
    const start = await slack("chat.startStream", { channel, thread_ts: root.ts, markdown_text: "Hello ", recipient_user_id: me.user_id, recipient_team_id: me.team_id });
    expectOk(start, "chat.startStream");
    const append = await slack("chat.appendStream", { channel, ts: start.ts, markdown_text: "from the june live check." });
    expectOk(append, "chat.appendStream");
    const stop = await slack("chat.stopStream", { channel, ts: start.ts });
    expectOk(stop, "chat.stopStream");
    // read back — conversations.replies wants URL-encoded GET; skip the assert without history scope
    const replies = await slackGet("conversations.replies", { channel: channel!, ts: root.ts! });
    if (replies.ok) expect(replies.messages?.find((m) => m.ts === start.ts)?.text).toBe("Hello from the june live check.");
  }, 30_000);

  test("a stopped stream refuses further appends (the stopped_by_user family)", async () => {
    const me = await whoami();
    const root = await slack("chat.postMessage", { channel, text: "june live-check root (stop)" });
    expectOk(root, "chat.postMessage (root)");
    const start = await slack("chat.startStream", { channel, thread_ts: root.ts, markdown_text: "closing…", recipient_user_id: me.user_id, recipient_team_id: me.team_id });
    expectOk(start, "chat.startStream");
    await slack("chat.stopStream", { channel, ts: start.ts });
    const late = await slack("chat.appendStream", { channel, ts: start.ts, markdown_text: "too late" });
    expect(late.ok).toBe(false); // e.g. message_not_in_streaming_state — the state our renderer salvages on
  }, 30_000);

  test("task_update chunks and feedback blocks are accepted (the agent-timeline contract)", async () => {
    const me = await whoami();
    const root = await slack("chat.postMessage", { channel, text: "june live-check root (tasks)" });
    expectOk(root, "chat.postMessage (root)");
    // a chunk can OPEN the stream (no markdown_text) — the renderer relies on this for tool-first turns
    const start = await slack("chat.startStream", {
      channel, thread_ts: root.ts, task_display_mode: "timeline",
      recipient_user_id: me.user_id, recipient_team_id: me.team_id,
      chunks: [{ type: "task_update", id: "c1", title: "Searching the thread", status: "in_progress" }],
    });
    expectOk(start, "chat.startStream (task chunk seed)");
    // a chunks-opened stream is in CHUNKS MODE: raw markdown_text here is
    // streaming_mode_mismatch (live-verified) — text must ride as a markdown_text chunk
    const text = await slack("chat.appendStream", { channel, ts: start.ts, chunks: [{ type: "markdown_text", text: "Found it." }] });
    expectOk(text, "chat.appendStream (markdown_text chunk)");
    const done = await slack("chat.appendStream", {
      channel, ts: start.ts,
      chunks: [{ type: "task_update", id: "c1", title: "Searching the thread", status: "complete" }],
    });
    expectOk(done, "chat.appendStream (task complete chunk)");
    // stopStream carries the feedback buttons (context_actions + feedback_buttons)
    const stop = await slack("chat.stopStream", {
      channel, ts: start.ts,
      blocks: [{
        type: "context_actions",
        elements: [{
          type: "feedback_buttons",
          action_id: "june_feedback",
          positive_button: { text: { type: "plain_text", text: "Good response" }, value: JSON.stringify({ rating: "positive" }) },
          negative_button: { text: { type: "plain_text", text: "Bad response" }, value: JSON.stringify({ rating: "negative" }) },
        }],
      }],
    });
    expectOk(stop, "chat.stopStream (feedback blocks)");
  }, 30_000);

  test("startStream without thread_ts or recipient ids is rejected (documents the anchor rule)", async () => {
    const r = await slack("chat.startStream", { channel, markdown_text: "top-level without a recipient" });
    expect(r.ok).toBe(false); // requires thread_ts, or recipient_user_id + recipient_team_id
  }, 30_000);
});
