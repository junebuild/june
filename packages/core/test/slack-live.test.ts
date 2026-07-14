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

describe.skipIf(!token || !channel)("slack live: the chat.startStream contract", () => {
  test("start → append → stop lands ONE streamed message holding the full text", async () => {
    const root = await slack("chat.postMessage", { channel, text: "june live-check root" });
    expect(root.ok).toBe(true);
    const start = await slack("chat.startStream", { channel, thread_ts: root.ts, markdown_text: "Hello " });
    expect(start.ok).toBe(true);
    const append = await slack("chat.appendStream", { channel, ts: start.ts, markdown_text: "from the june live check." });
    expect(append.ok).toBe(true);
    const stop = await slack("chat.stopStream", { channel, ts: start.ts });
    expect(stop.ok).toBe(true);
    // read back — conversations.replies wants URL-encoded GET; skip the assert without history scope
    const res = await fetch(`https://slack.com/api/conversations.replies?${new URLSearchParams({ channel: channel!, ts: root.ts! })}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const replies = (await res.json()) as Reply;
    if (replies.ok) expect(replies.messages?.find((m) => m.ts === start.ts)?.text).toBe("Hello from the june live check.");
  }, 30_000);

  test("a stopped stream refuses further appends (the stopped_by_user family)", async () => {
    const root = await slack("chat.postMessage", { channel, text: "june live-check root (stop)" });
    const start = await slack("chat.startStream", { channel, thread_ts: root.ts, markdown_text: "closing…" });
    expect(start.ok).toBe(true);
    await slack("chat.stopStream", { channel, ts: start.ts });
    const late = await slack("chat.appendStream", { channel, ts: start.ts, markdown_text: "too late" });
    expect(late.ok).toBe(false); // e.g. message_not_in_streaming_state — the state our renderer salvages on
  }, 30_000);

  test("task_update chunks and feedback blocks are accepted (the agent-timeline contract)", async () => {
    const root = await slack("chat.postMessage", { channel, text: "june live-check root (tasks)" });
    expect(root.ok).toBe(true);
    // a chunk can OPEN the stream (no markdown_text) — the renderer relies on this for tool-first turns
    const start = await slack("chat.startStream", {
      channel, thread_ts: root.ts, task_display_mode: "timeline",
      chunks: [{ type: "task_update", id: "c1", title: "Searching the thread", status: "in_progress" }],
    });
    expect(start.ok).toBe(true);
    const text = await slack("chat.appendStream", { channel, ts: start.ts, markdown_text: "Found it." });
    expect(text.ok).toBe(true);
    const done = await slack("chat.appendStream", {
      channel, ts: start.ts,
      chunks: [{ type: "task_update", id: "c1", title: "Searching the thread", status: "complete" }],
    });
    expect(done.ok).toBe(true);
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
    expect(stop.ok).toBe(true);
  }, 30_000);

  test("startStream without thread_ts or recipient ids is rejected (documents the anchor rule)", async () => {
    const r = await slack("chat.startStream", { channel, markdown_text: "top-level without a recipient" });
    expect(r.ok).toBe(false); // requires thread_ts, or recipient_user_id + recipient_team_id
  }, 30_000);
});
