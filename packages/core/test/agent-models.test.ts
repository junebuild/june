// The Anthropic model adapter. The provider call is thin glue over two pure
// mappings (June transcript ↔ Anthropic Messages), so those get the coverage; the
// adapter itself is checked for shape + the helpful error when the optional
// @anthropic-ai/sdk peer isn't installed.

import { describe, expect, test } from "bun:test";
import type { Msg } from "@junejs/core/agent-runtime";
import { anthropic, finishFromStopReason, fromAnthropicContent, toAnthropicMessages } from "@junejs/core/agent-models";

describe("toAnthropicMessages", () => {
  test("a user message becomes plain text content", () => {
    expect(toAnthropicMessages([{ role: "user", turnId: "t1", text: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });

  test("a `trigger` (proactive seed) maps to a plain user message — no new provider role (P4 §9)", () => {
    const msgs: Msg[] = [{ role: "trigger", turnId: "t1", text: "Summarize today's open threads.", by: "cron:daily" }];
    expect(toAnthropicMessages(msgs)).toEqual([{ role: "user", content: "Summarize today's open threads." }]);
  });

  test("an assistant message becomes text + tool_use blocks", () => {
    const msgs: Msg[] = [{ role: "assistant", turnId: "t1", text: "Placing it.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget" } }] }];
    expect(toAnthropicMessages(msgs)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Placing it." }, { type: "tool_use", id: "c1", name: "create_order", input: { item: "widget" } }] },
    ]);
  });

  test("consecutive tool results fold into one user message of tool_result blocks", () => {
    const msgs: Msg[] = [
      { role: "assistant", turnId: "t1", text: "", toolCalls: [{ id: "c1", name: "a", input: {} }, { id: "c2", name: "b", input: {} }] },
      { role: "tool", turnId: "t1", toolCallId: "c1", name: "a", result: { ok: 1 } },
      { role: "tool", turnId: "t1", toolCallId: "c2", name: "b", result: { ok: 2 } },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(2); // the assistant turn + ONE grouped user turn
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: JSON.stringify({ ok: 1 }) },
        { type: "tool_result", tool_use_id: "c2", content: JSON.stringify({ ok: 2 }) },
      ],
    });
  });

  test("a full order flow round-trips into the expected message sequence", () => {
    const msgs: Msg[] = [
      { role: "user", turnId: "t1", text: "order 3 widgets" },
      { role: "assistant", turnId: "t1", text: "", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
      { role: "tool", turnId: "t1", toolCallId: "c1", name: "create_order", result: { orderId: 1 } },
      { role: "assistant", turnId: "t1", text: "Done.", toolCalls: [] },
    ];
    expect(toAnthropicMessages(msgs).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("fromAnthropicContent", () => {
  test("concatenates text and extracts tool_use blocks", () => {
    expect(
      fromAnthropicContent([
        { type: "text", text: "Let me " },
        { type: "text", text: "check." },
        { type: "tool_use", id: "c1", name: "lookup", input: { item: "widget" } },
      ]),
    ).toEqual({ text: "Let me check.", toolCalls: [{ id: "c1", name: "lookup", input: { item: "widget" } }] });
  });

  test("no tool_use ⇒ empty toolCalls (the turn is done)", () => {
    expect(fromAnthropicContent([{ type: "text", text: "All set." }])).toEqual({ text: "All set.", toolCalls: [] });
  });
});

describe("finishFromStopReason", () => {
  test("maps every documented Messages API stop_reason to the normalized ModelFinish", () => {
    // the SDK's Message.stop_reason vocabulary (@anthropic-ai/sdk ≥0.60)
    expect(finishFromStopReason("end_turn")).toEqual({ reason: "stop", raw: "end_turn" });
    expect(finishFromStopReason("stop_sequence")).toEqual({ reason: "stop", raw: "stop_sequence" });
    expect(finishFromStopReason("tool_use")).toEqual({ reason: "stop", raw: "tool_use" });
    expect(finishFromStopReason("max_tokens")).toEqual({ reason: "max_tokens", raw: "max_tokens" });
    expect(finishFromStopReason("model_context_window_exceeded")).toEqual({ reason: "max_tokens", raw: "model_context_window_exceeded" });
    expect(finishFromStopReason("refusal")).toEqual({ reason: "refusal", raw: "refusal" });
    expect(finishFromStopReason("pause_turn")).toEqual({ reason: "other", raw: "pause_turn" });
    expect(finishFromStopReason("some_future_value")).toEqual({ reason: "other", raw: "some_future_value" });
    // null/undefined = no claim — the engine keeps legacy behavior
    expect(finishFromStopReason(null)).toBeUndefined();
    expect(finishFromStopReason(undefined)).toBeUndefined();
  });
});

describe("anthropic()", () => {
  test("returns a Model function", () => {
    expect(typeof anthropic({ model: "claude-opus-4-8" })).toBe("function");
  });

  test("the done delta carries the finalMessage's stop_reason as a normalized finish", async () => {
    const client = {
      messages: {
        stream: () =>
          Object.assign((async function* () {})(), {
            finalMessage: async () => ({ content: [], stop_reason: "max_tokens" }),
          }),
      },
    };
    const model = anthropic({ client, apiKey: "unused" });
    const deltas = [];
    for await (const d of model([{ role: "user", turnId: "t1", text: "hi" }], [])) deltas.push(d);
    expect(deltas).toEqual([
      { type: "done", reply: { text: "", toolCalls: [] }, finish: { reason: "max_tokens", raw: "max_tokens" } },
    ]);
  });

  test("calling it without the optional @anthropic-ai/sdk peer throws a helpful error", async () => {
    const model = anthropic();
    // the model is a stream now; the missing-dep error surfaces when it's iterated
    const drain = async () => { for await (const _ of model([{ role: "user", turnId: "t1", text: "hi" }], [])) void _; };
    await expect(drain()).rejects.toThrow(/install @anthropic-ai\/sdk/);
  });
});
