// agent-models.ts — Model-seam adapters. The agent runtime's Model is a plain
// provider-agnostic function (msgs, tools) => reply; this turns a provider into
// one. Ships `anthropic()` (the official @anthropic-ai/sdk).
//
// @anthropic-ai/sdk is an OPTIONAL peer: it's imported lazily via a non-literal
// specifier so `@junejs/core` stays installable + typecheckable without it (only
// `anthropic()` at call time needs it). Same structural-typing / no-hard-dep
// discipline as the D1 and sqlite drivers. The SDK is isomorphic, so this runs on
// native AND edge (a Durable Object) — pass `apiKey` explicitly on edge, where
// there is no process.env.

import type { Model, ModelDelta, ModelReply, Msg, ToolSpec } from "./agent-runtime";

// Structural subset of the Anthropic Messages shapes we emit/read — no
// `@anthropic-ai/sdk` type import, so core typechecks without the optional dep.
type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
export type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicBlock[] };

// June transcript → Anthropic messages. Consecutive tool results are folded into
// one user message (the API's shape for parallel tool_result blocks).
export function toAnthropicMessages(msgs: Msg[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const content: AnthropicBlock[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      out.push({ role: "assistant", content });
    } else {
      const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: JSON.stringify(m.result) };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) prev.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

// Anthropic response content → the engine's ModelReply.
export function fromAnthropicContent(content: AnthropicBlock[]): ModelReply {
  let text = "";
  const toolCalls: ModelReply["toolCalls"] = [];
  for (const b of content) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, input: b.input });
  }
  return { text, toolCalls };
}

// Structural view of just the SDK surface we call (no dependency on its types). The
// message stream is async-iterable over raw stream events AND exposes finalMessage().
type AnthropicStreamEvent = { type: string; delta?: { type?: string; text?: string; thinking?: string } };
type AnthropicStream = AsyncIterable<AnthropicStreamEvent> & { finalMessage(): Promise<{ content: AnthropicBlock[] }> };
type AnthropicClient = {
  messages: { stream(body: unknown): AnthropicStream };
};
type AnthropicCtor = new (opts?: { apiKey?: string }) => AnthropicClient;

export type AnthropicOptions = {
  model?: string; // default: claude-opus-4-8
  apiKey?: string; // omit on native (reads ANTHROPIC_API_KEY); REQUIRED on edge
  system?: string; // system prompt (e.g. buildSystemPrompt(agent))
  maxTokens?: number; // default 16000
  thinking?: boolean; // default false — see note below
};

export function anthropic(opts: AnthropicOptions = {}): Model {
  const model = opts.model ?? "claude-opus-4-8";
  const maxTokens = opts.maxTokens ?? 16000;
  return (msgs: Msg[], tools: ToolSpec[], callOpts?: { system?: string }): AsyncIterable<ModelDelta> =>
    (async function* () {
      // Per-call system (the runtime injects the agent's instructions) wins over a
      // construction-time default.
      const system = callOpts?.system ?? opts.system;
      // Non-literal specifier (typed `string`) so tsc/bundlers don't require the
      // optional dep and it stays lazy.
      const specifier: string = "@anthropic-ai/sdk";
      let Anthropic: AnthropicCtor;
      try {
        Anthropic = ((await import(specifier)) as { default: AnthropicCtor }).default;
      } catch {
        throw new Error("anthropic(): install @anthropic-ai/sdk to use the Anthropic model adapter");
      }
      const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : undefined);

      // Stream the SDK's raw events → yield reasoning/answer token deltas as they arrive,
      // then finalMessage() → the authoritative assembled reply as `done`. Thinking is OFF
      // by default: the durable transcript (Msg) doesn't yet persist thinking blocks, and
      // replaying an assistant tool-use turn under adaptive thinking requires echoing them
      // back verbatim — opt in once block persistence lands.
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        thinking: opts.thinking ? { type: "adaptive" } : { type: "disabled" },
        ...(system ? { system } : {}),
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input })),
        messages: toAnthropicMessages(msgs),
      });
      for await (const ev of stream) {
        if (ev.type !== "content_block_delta" || !ev.delta) continue;
        if (ev.delta.type === "text_delta" && ev.delta.text) yield { type: "text", text: ev.delta.text };
        else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) yield { type: "reasoning", text: ev.delta.thinking };
      }
      const message = await stream.finalMessage();
      yield { type: "done", reply: fromAnthropicContent(message.content) };
    })();
}
