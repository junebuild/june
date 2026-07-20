// The adapter conformance suite (#105), proven three ways: a faithful reference
// adapter passes every scenario; deliberately-broken adapters are CAUGHT by the
// exact scenario naming their bug class (each fixture isolates ONE defect); and
// June's own anthropic() adapter — its real mapping/streaming code over an
// injected fake transport — passes the suite, which is the "runnable contract"
// claim made good. The wire-content assertions run through `capture`: the stub
// reports each request the adapter built, so a mapping that drops transcript
// content fails even though the engine handed the adapter everything.

import { describe, expect, test } from "bun:test";
import { runAdapterConformance, type ScriptedReply } from "@junejs/core/test";
import { anthropic, fromAnthropicContent, toAnthropicMessages, type AnthropicBlock, type AnthropicClient, type AnthropicResponseBlock, type AnthropicStream, type AnthropicStreamEvent } from "@junejs/core/agent-models";
import type { Model, ModelDelta, Msg } from "@junejs/core/agent-runtime";

// A faithful reference adapter: plays the script back in June terms, forwarding
// deltas and reporting its "wire request" (here: the transcript it would send —
// any serialization carrying the content satisfies the containment checks).
function referenceAdapter(script: ScriptedReply[], capture: (w: unknown) => void): Model {
  let i = 0;
  return (msgs) => (async function* () {
    capture(msgs);
    const s = script[i++];
    if (!s) throw new Error("reference adapter: script exhausted");
    for (const r of s.reasoning ?? []) yield { type: "reasoning", text: r } as ModelDelta;
    for (const d of s.deltas ?? []) yield { type: "text", text: d } as ModelDelta;
    yield { type: "done", reply: s.reply } as ModelDelta;
  })();
}

describe("runAdapterConformance (#105)", () => {
  test("a faithful adapter passes every scenario", async () => {
    const report = await runAdapterConformance(referenceAdapter);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.passed).toHaveLength(8);
  });

  test("usesProviderState/streaming opt-outs skip (not fail) their scenarios", async () => {
    const report = await runAdapterConformance(referenceAdapter, { usesProviderState: false, streaming: false });
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual(["delta forwarding: scripted reasoning/text deltas arrive, in order, before done", "providerState round-trip"]);
  });

  test("a double-done adapter is caught by the terminal-done scenario alone", async () => {
    const broken: typeof referenceAdapter = (script, capture) => {
      const faithful = referenceAdapter(script, capture);
      return (msgs, tools, o) => (async function* () {
        let done: ModelDelta | undefined;
        for await (const d of faithful(msgs, tools, o)) { yield d; if (d.type === "done") done = d; }
        if (done) yield done; // the ONE defect: done emitted twice
      })();
    };
    const report = await runAdapterConformance(broken);
    expect(report.failed.map((f) => f.scenario)).toEqual(["terminal done discipline: exactly one done, nothing after"]);
    expect(report.failed[0]!.error).toContain("exactly ONE done");
  });

  test("a delta-swallowing adapter is caught by delta forwarding alone", async () => {
    const swallowing: typeof referenceAdapter = (script, capture) => {
      const faithful = referenceAdapter(script, capture);
      return (msgs, tools, o) => (async function* () {
        for await (const d of faithful(msgs, tools, o)) if (d.type === "done") yield d; // drops every delta
      })();
    };
    const report = await runAdapterConformance(swallowing);
    expect(report.failed.map((f) => f.scenario)).toEqual(["delta forwarding: scripted reasoning/text deltas arrive, in order, before done"]);
    expect(report.failed[0]!.error).toContain("forwarded in order");
  });

  test("an adapter that drops providerState is caught by exactly that scenario", async () => {
    const dropping: typeof referenceAdapter = (script, capture) => {
      const stripped = script.map((s) => ({ ...s, reply: { text: s.reply.text, toolCalls: s.reply.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })) } }));
      return referenceAdapter(stripped, capture); // the ONE defect: the wire had no slot and the mapping discarded it
    };
    const report = await runAdapterConformance(dropping);
    expect(report.failed.map((f) => f.scenario)).toEqual(["providerState round-trip"]);
    expect(report.failed[0]!.error).toContain("providerState");
  });

  test("an adapter that IGNORES the transcript is caught by the wire-content checks", async () => {
    // Passes every engine-side observation (the script drives the replies) but its
    // "wire requests" carry none of the transcript — pre-capture, this passed.
    const amnesiac: typeof referenceAdapter = (script, capture) => {
      const faithful = referenceAdapter(script, (/* msgs */) => capture({ model: "x", messages: [] }));
      return faithful;
    };
    const report = await runAdapterConformance(amnesiac);
    const failedNames = report.failed.map((f) => f.scenario);
    expect(failedNames).toContain("plain-text turn"); // user text missing from the wire
    expect(failedNames).toContain("proactive trigger-role turn"); // seed text missing
    expect(failedNames).toContain("tool round-trip (empty assistant text + tool call)"); // result missing
    expect(report.failed.find((f) => f.scenario === "plain-text turn")!.error).toContain("transcript mapping dropped it");
  });

  test("an adapter that chokes on the trigger role is caught by the proactive scenario", async () => {
    const choking: typeof referenceAdapter = (script, capture) => {
      const faithful = referenceAdapter(script, capture);
      return (msgs, tools, o) => {
        if (msgs.some((m) => m.role === "trigger")) throw new Error("unsupported role: trigger"); // the dev.9 bug class
        return faithful(msgs, tools, o);
      };
    };
    const report = await runAdapterConformance(choking);
    expect(report.failed.map((f) => f.scenario)).toEqual(["proactive trigger-role turn"]);
    expect(report.failed[0]!.error).toContain("trigger");
  });

  test("June's own anthropic() adapter passes the suite over an injected fake transport", async () => {
    // The fake client converts the June-terms script into Anthropic wire shapes and
    // reports each request body via capture; the adapter's REAL toAnthropicMessages /
    // fromAnthropicContent / stream handling runs — including the wire-content checks
    // against the request the real mapping produced.
    const fakeClient = (script: ScriptedReply[], capture: (w: unknown) => void): AnthropicClient => {
      let i = 0;
      return {
        messages: {
          stream(body: unknown): AnthropicStream {
            capture(body); // the request the REAL adapter built
            const s = script[i++];
            if (!s) throw new Error("fake anthropic: script exhausted");
            const events: AnthropicStreamEvent[] = [
              ...(s.reasoning ?? []).map((t) => ({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: t } })),
              ...(s.deltas ?? []).map((t) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } })),
            ];
            const content: AnthropicBlock[] = [
              ...(s.reply.text ? [{ type: "text", text: s.reply.text } as AnthropicBlock] : []),
              ...s.reply.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }) as AnthropicBlock),
            ];
            return Object.assign(
              (async function* () { for (const e of events) yield e; })(),
              { finalMessage: async () => ({ content }) },
            );
          },
        },
      };
    };
    const report = await runAdapterConformance(
      (script, capture) => anthropic({ client: fakeClient(script, capture), apiKey: "unused" }),
      { usesProviderState: false }, // Anthropic attaches no opaque per-call state — honest skip
    );
    expect(report.failed).toEqual([]);
    expect(report.passed).toHaveLength(7);
    expect(report.skipped).toEqual(["providerState round-trip"]);
  });

  test("AnthropicClient accepts an SDK-shaped client (broad response union, narrow stream param)", () => {
    // Mirrors the REAL SDK's surface: finalMessage content is a BROADER union than
    // we consume (thinking/redacted blocks), and stream takes a NARROW params type.
    // If AnthropicClient over-pins either side, `client:` injection rejects the real
    // `new Anthropic()` — this must keep typechecking. (Compile-time assertion.)
    type SdkishBlock =
      | { type: "text"; text: string; citations: unknown[] }
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | { type: "thinking"; thinking: string; signature: string }
      | { type: "redacted_thinking"; data: string };
    type SdkishParams = { model: string; max_tokens: number; messages: unknown[] };
    const sdkish = {
      messages: {
        stream(_body: SdkishParams) {
          return Object.assign(
            (async function* (): AsyncGenerator<{ type: "content_block_delta"; delta: { type: "text_delta"; text: string } }> {})(),
            { finalMessage: async () => ({ id: "m1", role: "assistant" as const, content: [] as SdkishBlock[] }) },
          );
        },
      },
    };
    const compat: AnthropicClient = sdkish; // the actual assertion — fails to compile if over-pinned
    expect(compat).toBe(sdkish);
    // and an UNRELATED transport is rejected at the type level, not at runtime:
    // its param satisfies neither direction of the bivariant check
    const unrelated = { messages: { stream(_body: { token: string }) { return sdkish.messages.stream({ model: "x", max_tokens: 1, messages: [] }); } } };
    // @ts-expect-error — a client that cannot consume anthropic()'s request must not typecheck
    const rejected: AnthropicClient = unrelated;
    expect(rejected).toBeDefined();
    // and the consumer narrows: unknown response blocks are skipped, not crashed on
    const reply = fromAnthropicContent([
      { type: "thinking", text: undefined } as AnthropicResponseBlock,
      { type: "text", text: "hi" },
      { type: "tool_use", id: "c1", name: "echo", input: { a: 1 } },
      { type: "redacted_thinking" },
    ]);
    expect(reply).toEqual({ text: "hi", toolCalls: [{ id: "c1", name: "echo", input: { a: 1 } }] });
  });

  test("toAnthropicMessages folds consecutive tool results into one user message", () => {
    // the wire-shape detail the containment checks deliberately do NOT pin down,
    // asserted directly against June's own mapping
    const msgs: Msg[] = [
      { role: "user", turnId: "t1", text: "go" },
      { role: "assistant", turnId: "t1", text: "", toolCalls: [{ id: "c1", name: "echo", input: {} }, { id: "c2", name: "add", input: {} }] },
      { role: "tool", turnId: "t1", toolCallId: "c1", name: "echo", result: { echoed: 1 } },
      { role: "tool", turnId: "t1", toolCallId: "c2", name: "add", result: { sum: 3 } },
    ];
    const wire = toAnthropicMessages(msgs);
    expect(wire).toHaveLength(3); // user, assistant, ONE folded user message with both results
    const folded = wire[2]!;
    expect(folded.role).toBe("user");
    expect(Array.isArray(folded.content) && folded.content.filter((b) => b.type === "tool_result")).toHaveLength(2);
  });
});
