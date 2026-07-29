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

import type { Model, ModelDelta, ModelFinish, ModelReply, Msg, ToolSpec } from "./agent-runtime";

// Structural subset of the Anthropic Messages shapes we emit/read — no
// `@anthropic-ai/sdk` type import, so core typechecks without the optional dep.
export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
export type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicBlock[] };

// June transcript → Anthropic messages. Consecutive tool results are folded into
// one user message (the API's shape for parallel tool_result blocks).
export function toAnthropicMessages(msgs: Msg[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    if (m.role === "user" || m.role === "trigger") {
      // A `trigger` (proactive seed) maps to a plain user message: providers needn't support a
      // new role, and the model just acts on the seed text as its opening instruction (§9 / #6).
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

// Response-side content block: an OPEN shape, not the request union above — the
// real SDK returns a broader ContentBlock union (thinking, redacted_thinking, …)
// than we consume, and pinning `content` to AnthropicBlock[] would make the REAL
// `new Anthropic()` client fail the structural check that `client:` injection
// exists for. Every SDK block satisfies this (a `type` string; the text/tool_use
// fields optional); fromAnthropicContent narrows on `type` and reads only what
// it needs.
export type AnthropicResponseBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };

// Anthropic response content → the engine's ModelReply. Accepts the open
// response-side shape; only text and tool_use blocks are consumed.
export function fromAnthropicContent(content: AnthropicResponseBlock[]): ModelReply {
  let text = "";
  const toolCalls: ModelReply["toolCalls"] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") toolCalls.push({ id: b.id, name: b.name, input: b.input });
  }
  return { text, toolCalls };
}

// The request shape anthropic() always sends — the injection contract's input
// side. Structural and minimal (required fields only where the adapter always
// emits them; loose value types so the SDK's richer types stay assignable): a
// client whose stream() cannot consume this object (an unrelated transport,
// e.g. `stream(body: { token: string })`) fails BOTH directions of the method's
// bivariant parameter check and is rejected at the type level, while the real
// SDK's (narrower, richer) params type still satisfies it.
export type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: unknown[];
  thinking?: unknown;
  tools?: unknown[];
  system?: unknown;
};

// Structural view of just the SDK surface we call (no dependency on its types). The
// message stream is async-iterable over raw stream events AND exposes finalMessage().
// `stream` is a METHOD signature deliberately (bivariant), so the SDK's narrower
// parameter type still satisfies it. `stop_reason` is the Messages API's why-it-stopped
// field (@anthropic-ai/sdk ≥0.60 Message: end_turn / max_tokens / stop_sequence /
// tool_use / pause_turn / refusal / model_context_window_exceeded / null) — optional
// here so a minimal fake transport stays assignable.
export type AnthropicStreamEvent = { type: string; delta?: { type?: string; text?: string; thinking?: string } };
export type AnthropicStream = AsyncIterable<AnthropicStreamEvent> & { finalMessage(): Promise<{ content: AnthropicResponseBlock[]; stop_reason?: string | null }> };
export type AnthropicClient = {
  messages: { stream(body: AnthropicRequest): AnthropicStream };
};
type AnthropicCtor = new (opts?: { apiKey?: string }) => AnthropicClient;

export type AnthropicOptions = {
  model?: string; // default: claude-opus-4-8
  apiKey?: string; // omit on native (reads ANTHROPIC_API_KEY); REQUIRED on edge
  system?: string; // system prompt (e.g. buildSystemPrompt(agent))
  maxTokens?: number; // default 16000
  thinking?: boolean; // default false — see note below
  // Inject a preconstructed client (structural — anything with messages.stream):
  // tests drive the adapter's real mapping/streaming code against a fake transport
  // (see runAdapterConformance), and custom transports skip the SDK entirely.
  // When set, the lazy @anthropic-ai/sdk import is skipped.
  client?: AnthropicClient;
};

export function anthropic(opts: AnthropicOptions = {}): Model {
  const model = opts.model ?? "claude-opus-4-8";
  const maxTokens = opts.maxTokens ?? 16000;
  return (msgs: Msg[], tools: ToolSpec[], callOpts?: { system?: string }): AsyncIterable<ModelDelta> =>
    (async function* () {
      // Per-call system (the runtime injects the agent's instructions) wins over a
      // construction-time default.
      const system = callOpts?.system ?? opts.system;
      let client = opts.client;
      if (!client) {
        // Non-literal specifier (typed `string`) so tsc/bundlers don't require the
        // optional dep and it stays lazy.
        const specifier: string = "@anthropic-ai/sdk";
        let Anthropic: AnthropicCtor;
        try {
          Anthropic = ((await import(specifier)) as { default: AnthropicCtor }).default;
        } catch {
          throw new Error("anthropic(): install @anthropic-ai/sdk to use the Anthropic model adapter");
        }
        client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : undefined);
      }

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
      // Spread, don't assign: a transport that omits stop_reason must yield the same delta
      // shape as before this field existed (no own `finish: undefined` property).
      const finish = finishFromStopReason(message.stop_reason);
      yield { type: "done", reply: fromAnthropicContent(message.content), ...(finish ? { finish } : {}) };
    })();
}

// Messages API stop_reason → the engine's normalized ModelFinish. The engine only acts
// on the abnormal-AND-empty combination (agent-runtime.ts modelStep), so the mapping's
// job is honesty, not policy: `stop` covers every reason that means "the model chose to
// stop here" (a tool_use stop is a normal mid-turn stop — the reply carries the calls);
// model_context_window_exceeded folds into max_tokens (both mean "ran out of room");
// pause_turn (server-tool loop parked — this adapter runs no server tools) and any
// future value fall to `other` with the provider's own string preserved in `raw`.
// Exported for tests.
export function finishFromStopReason(stopReason: string | null | undefined): ModelFinish | undefined {
  if (stopReason == null) return undefined; // e.g. a minimal fake transport — no claim, engine keeps legacy behavior
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return { reason: "stop", raw: stopReason };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { reason: "max_tokens", raw: stopReason };
    case "refusal":
      return { reason: "refusal", raw: stopReason };
    default:
      return { reason: "other", raw: stopReason };
  }
}
