// The Anthropic model adapter. The provider call is thin glue over two pure
// mappings (June transcript ↔ Anthropic Messages), so those get the coverage; the
// adapter itself is checked for shape + the helpful error when the optional
// @anthropic-ai/sdk peer isn't installed.

import { describe, expect, test } from "bun:test";
import type { Msg } from "@junejs/core/agent-runtime";
import { anthropic, fromAnthropicContent, toAnthropicMessages } from "@junejs/core/agent-models";

describe("toAnthropicMessages", () => {
  test("a user message becomes plain text content", () => {
    expect(toAnthropicMessages([{ role: "user", turnId: "t1", text: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
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

describe("anthropic()", () => {
  test("returns a Model function", () => {
    expect(typeof anthropic({ model: "claude-opus-4-8" })).toBe("function");
  });

  test("calling it without the optional @anthropic-ai/sdk peer throws a helpful error", async () => {
    const model = anthropic();
    // the model is a stream now; the missing-dep error surfaces when it's iterated
    const drain = async () => { for await (const _ of model([{ role: "user", turnId: "t1", text: "hi" }], [])) void _; };
    await expect(drain()).rejects.toThrow(/install @anthropic-ai\/sdk/);
  });
});
