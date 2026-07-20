// test.ts — the @junejs/core/test entry (#93): the scaffolding every June app's
// channel tests were re-implementing by hand (crisp-agent hand-rolled Slack HMAC
// signing three times, a fake ChannelContext, and a fake streaming host — and each
// re-implementation drifts as the real surfaces grow). Shipping the helpers INSIDE
// core keeps them in lockstep with the surfaces they fake by construction: a
// ChannelContext change lands in the same package version as the fake that mirrors
// it. Pure contract-layer code (zero node:*), like everything else in core.

import { AgentSession } from "./agent-runtime";
import type {
  EventSink,
  InputRequest,
  Model,
  ModelDelta,
  ModelReply,
  Msg,
  ProactiveTrigger,
  Runtime,
  SessionStore,
  Tool,
  TurnError,
  TurnEvent,
  TurnTrigger,
} from "./agent-runtime";
import type { AgentDefinition, ChannelContext } from "./agent-config";

// ── signed webhook requests ───────────────────────────────────────────────────
// Build a Request the real channel webhook accepts — the test exercises the SAME
// signature verification that runs in production instead of stubbing around it.

const enc = new TextEncoder();
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Slack signs v0=HMAC-SHA256("v0:{ts}:{rawBody}") with a SECONDS timestamp. `ts`
// overrides for staleness tests (the channel rejects ±5 min).
export async function signSlackRequest(
  signingSecret: string,
  body: string,
  opts: { ts?: string; url?: string } = {},
): Promise<Request> {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + (await hmacSha256Hex(signingSecret, `v0:${ts}:${body}`));
  return new Request(opts.url ?? "http://test/channels/slack", {
    method: "POST",
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

// Crisp signs HMAC-SHA256("[{ts};{body}]") with a MILLISECONDS timestamp.
export async function signCrispRequest(
  signingSecret: string,
  body: string,
  opts: { ts?: string; url?: string } = {},
): Promise<Request> {
  const ts = opts.ts ?? String(Date.now());
  const sig = await hmacSha256Hex(signingSecret, `[${ts};${body}]`);
  return new Request(opts.url ?? "http://test/channels/crisp", {
    method: "POST",
    headers: { "x-crisp-request-timestamp": ts, "x-crisp-signature": sig },
    body,
  });
}

// ── turn-event stream fixtures ────────────────────────────────────────────────
// Build the TurnEvent sequence a streaming host would emit for one turn, so a
// `stream: true` render path can be exercised without a real engine: turn.started,
// reasoning/message deltas, then EXACTLY ONE terminal (input.requested | turn.failed
// | message.completed + turn.completed) — the same contract sseTurnStream closes on.
export function turnEvents(opts: {
  turnId?: string;
  // The FULL trigger union (inbound | proactive | resume), not just proactive — a
  // fixture for an inbound webhook stream must be able to open the way the real
  // engine does. Default: a proactive "test" seed.
  trigger?: TurnTrigger;
  reasoning?: string[];
  deltas?: string[];
  // terminal: `text` completes (default: the joined deltas), `fail` fails, `input` parks
  text?: string;
  fail?: string | TurnError;
  input?: InputRequest;
} = {}): TurnEvent[] {
  // Exactly one terminal: a contradictory fixture ({ text, fail }, { input, fail }, …)
  // would silently exercise a different render path than the test intended — throw
  // instead of picking a winner by precedence.
  const terminals = [opts.text !== undefined, opts.fail !== undefined, opts.input !== undefined].filter(Boolean).length;
  if (terminals > 1) throw new Error("turnEvents: pass at most ONE terminal (text | fail | input) — a turn has exactly one terminal event");
  const turnId = opts.turnId ?? "t_TEST";
  const out: TurnEvent[] = [{ type: "turn.started", turnId, trigger: opts.trigger ?? { kind: "proactive", by: "test" } }];
  for (const r of opts.reasoning ?? []) out.push({ type: "reasoning.delta", turnId, text: r });
  for (const d of opts.deltas ?? []) out.push({ type: "message.delta", turnId, text: d });
  if (opts.input) { out.push({ type: "input.requested", turnId, request: opts.input }); return out; }
  if (opts.fail !== undefined) {
    out.push({ type: "turn.failed", turnId, error: typeof opts.fail === "string" ? { message: opts.fail } : opts.fail });
    return out;
  }
  const text = opts.text ?? (opts.deltas ?? []).join("");
  // fidelity with the real engine: message.completed only fires for non-blank text
  // (a tool-only turn completes without one — see modelStep's reply.text.trim() gate)
  if (text.trim()) out.push({ type: "message.completed", turnId, text });
  out.push({ type: "turn.completed", turnId, text });
  return out;
}

// ── fake ChannelContext with call capture ─────────────────────────────────────
// Derived, not copied: this subpath exists so fakes can't drift from the real
// surface — a hand-copied option bag would go quietly stale when ChannelContext
// grows a field, while these break the build (or update themselves) in lockstep.
export type RunOpts = NonNullable<Parameters<ChannelContext["run"]>[1]>;
export type ResumeRequest = Parameters<NonNullable<ChannelContext["resumeStream"]>>[0];
export type TestContext = ChannelContext & {
  // Always installed here (the fast-ACK capture is the point of this fake), so the
  // type says so — no `ctx.waitUntil!` assertions in consumer tests. ChannelContext
  // keeps it optional because native hosts really may omit it.
  waitUntil: NonNullable<ChannelContext["waitUntil"]>;
  // Everything the channel asked the host to do, in order — assert against these.
  calls: {
    run: { message: string; opts?: RunOpts }[];
    runStream: { message: string; opts?: RunOpts }[];
    runDetached: { message: string; opts?: RunOpts }[];
    resumeStream: ResumeRequest[];
    waitUntil: Promise<unknown>[];
  };
  // Settle the fast-ACK background work: awaits every waitUntil-captured promise,
  // including ones enqueued WHILE settling (a turn that schedules a reply post).
  // Replaces the sleep-based `await flush()` guess with an exact join.
  flush: () => Promise<void>;
};

// A ChannelContext for driving a channel in tests. Everything is optional:
// - `reply` — what run() resolves (string, or a function of the message; default "ok").
// - `streamEvents` — providing it enables runStream (hosts without streaming omit it,
//   and channels feature-detect; a TurnEvent[] fixture or a function of the message).
// - `detached` — enables runDetached (resolves { turnId }).
// - `resumeEvents` — enables resumeStream (the HITL continuation stream).
// - `services` / `agent` — passed through / merged over a minimal AgentDefinition.
// waitUntil is ALWAYS captured (the fast-ACK contract every webhook rides); await
// ctx.flush() to settle the background work deterministically.
export function makeTestContext(opts: {
  reply?: string | ((message: string, o?: RunOpts) => string | Promise<string>);
  streamEvents?: TurnEvent[] | ((message: string, o?: RunOpts) => TurnEvent[]);
  detached?: boolean | { turnId?: string };
  resumeEvents?: TurnEvent[] | ((r: ResumeRequest) => TurnEvent[]);
  services?: unknown;
  agent?: Partial<AgentDefinition>;
} = {}): TestContext {
  const calls: TestContext["calls"] = { run: [], runStream: [], runDetached: [], resumeStream: [], waitUntil: [] };
  const agent: AgentDefinition = {
    name: "test-agent", instructions: "", tools: [], skills: [], channels: [], connections: [],
    ...opts.agent,
  };
  async function* toStream(events: TurnEvent[]): AsyncIterable<TurnEvent> {
    for (const e of events) yield e;
  }
  const ctx: TestContext = {
    agent,
    services: opts.services,
    run: async (message, o) => {
      calls.run.push({ message, opts: o });
      return typeof opts.reply === "function" ? opts.reply(message, o) : (opts.reply ?? "ok");
    },
    waitUntil: (p) => {
      calls.waitUntil.push(p);
      // Mark the rejection handled NOW: a task that rejects before flush() runs must
      // not trip the runtime's unhandled-rejection reporter mid-test — flush() still
      // reads the original promise and surfaces the failure via its AggregateError.
      void Promise.resolve(p).then(undefined, () => { /* surfaced by flush */ });
    },
    calls,
    flush: async () => {
      // Settle in waves (background work may enqueue more background work), then
      // SURFACE failures: the built-in channels' runBackground never rejects (its
      // .catch routes to onError), but a custom channel handing a raw promise to
      // waitUntil must not have its breakage swallowed into a green test.
      let settled = 0;
      const failures: unknown[] = [];
      while (settled < calls.waitUntil.length) {
        const batch = calls.waitUntil.slice(settled);
        settled = calls.waitUntil.length;
        for (const r of await Promise.allSettled(batch)) if (r.status === "rejected") failures.push(r.reason);
      }
      if (failures.length) throw new AggregateError(failures, `flush: ${failures.length} background task(s) rejected`);
    },
  };
  if (opts.streamEvents) {
    ctx.runStream = (message, o) => {
      calls.runStream.push({ message, opts: o });
      return toStream(typeof opts.streamEvents === "function" ? opts.streamEvents(message, o) : opts.streamEvents!);
    };
  }
  if (opts.detached) {
    ctx.runDetached = async (message, o) => {
      calls.runDetached.push({ message, opts: o });
      const turnId = o?.turnId ?? (typeof opts.detached === "object" ? opts.detached.turnId : undefined) ?? "t_TEST";
      return { turnId };
    };
  }
  if (opts.resumeEvents) {
    ctx.resumeStream = (r) => {
      calls.resumeStream.push(r);
      return toStream(typeof opts.resumeEvents === "function" ? opts.resumeEvents(r) : opts.resumeEvents!);
    };
  }
  return ctx;
}

// ── in-memory SessionStore ────────────────────────────────────────────────────
// A pure store for driving the REAL engine (AgentSession/runTurn) in tests — the
// same scaffold every engine-level test hand-rolls. `unwrap()` returns undefined:
// there is no app storage handle; a local tool that needs one brings its own store.
export function memorySessionStore(): SessionStore {
  const msgs: Msg[] = [];
  const steps = new Map<string, unknown>();
  let status = "new";
  return {
    appendMessage(m) { msgs.push(m); },
    messages() { return msgs.slice(); },
    hasOpeningMessage(t) { return msgs.some((m) => (m.role === "user" || m.role === "trigger") && m.turnId === t); },
    getStep(id) { return steps.has(id) ? steps.get(id) : undefined; },
    putStep(id, o) { steps.set(id, o); },
    delStep(id) { steps.delete(id); },
    getStatus() { return status; },
    setStatus(s) { status = s; },
    tx(fn) { return fn(); },
    unwrap<H = unknown>(): H { return undefined as H; },
  };
}

// ── adapter conformance (#105) ────────────────────────────────────────────────
// The Model-adapter contract, runnable: the seams every non-Anthropic adapter has
// re-discovered by shipping bugs (the dev.9 trigger→user mapping was learned by
// trial). The adapter author supplies ONE factory: given a script of replies (in
// June terms) and a `capture` callback, return their adapter wired to a stubbed
// transport that (a) plays the script back in the PROVIDER's wire shape and
// (b) calls `capture(wireRequest)` with each request the adapter actually built.
// The adapter's real mapping and streaming code runs; only the network is fake.
//
// `capture` is what makes the mapping VERIFIABLE, not assumed: the suite cannot
// know any provider's wire shape, but it can check CONTENT — a tool result's
// value, a trigger's seed text, a providerState string must appear SOMEWHERE in
// the serialized request, or the provider never saw them. An adapter that ignores
// the transcript entirely produces wire requests missing that content and fails
// here, instead of passing on engine-side observations alone.
export type ScriptedReply = { reasoning?: string[]; deltas?: string[]; reply: ModelReply };
export type ConformanceOptions = {
  // Providers with no opaque per-call state (e.g. Anthropic) cannot round-trip
  // providerState — set false and that scenario reports skipped, not failed.
  usesProviderState?: boolean;
  // Non-streaming providers deliver no incremental deltas — set false and the
  // delta-forwarding scenario reports skipped. The terminal-done discipline
  // scenario always runs: it is the hard contract for every adapter.
  streaming?: boolean;
};
export type ConformanceReport = { passed: string[]; skipped: string[]; failed: { scenario: string; error: string }[] };

export async function runAdapterConformance(
  makeModel: (script: ScriptedReply[], capture: (wireRequest: unknown) => void) => Model | Promise<Model>,
  opts: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const echoTool: Tool = { spec: { name: "echo", description: "echoes its input", input: { type: "object" } }, run: (input: unknown) => ({ echoed: input }) };
  const addTool: Tool = { spec: { name: "add", description: "adds", input: { type: "object" } }, run: () => ({ sum: 3 }) };
  const noRuntime: Runtime = { session() { throw new Error("conformance: no subagents"); } };

  // Serialize a captured wire request for content-containment checks. Provider-shape
  // agnostic on purpose: whatever the wire looks like, the CONTENT must be in it.
  const wireText = (w: unknown) => { try { return JSON.stringify(w) ?? String(w); } catch { return String(w); } };
  const wireHas = (wires: unknown[], i: number, needle: string, what: string) => {
    assert(wires.length > i, `expected a captured wire request #${i + 1} — the transport stub must call capture() per request`);
    assert(wireText(wires[i]).includes(needle), `wire request #${i + 1} must carry ${what} (looked for ${JSON.stringify(needle)}) — the adapter's transcript mapping dropped it`);
  };

  // Wrap the adapter to observe what it EMITS (each done.reply) while the engine
  // drives it; what it SENDS is observed via `capture` at the transport stub.
  function instrument(model: Model) {
    const invocations: { dones: ModelReply[] }[] = [];
    const wrapped: Model = (msgs, tools, o) => (async function* () {
      const rec = { dones: [] as ModelReply[] };
      invocations.push(rec);
      for await (const d of model(msgs, tools, o)) {
        if (d.type === "done") rec.dones.push(d.reply);
        yield d;
      }
    })();
    return { wrapped, invocations };
  }

  async function turn(model: Model, tools: Tool[], input: { userText: string; trigger?: ProactiveTrigger }) {
    const session = new AgentSession("conformance", "s1", memorySessionStore(), memorySink(), model, tools, noRuntime);
    return session.turn({ turnId: "t_conf", userText: input.userText, trigger: input.trigger });
  }

  const scenarios: { name: string; skip?: boolean; run: () => Promise<void> }[] = [
    {
      name: "plain-text turn",
      run: async () => {
        const wires: unknown[] = [];
        const model = await makeModel([{ reply: { text: "The answer is 4.", toolCalls: [] } }], (w) => wires.push(w));
        assert((await turn(model, [], { userText: "what is 2+2?" })) === "The answer is 4.", "final text must equal the scripted reply.text (done is authoritative)");
        wireHas(wires, 0, "what is 2+2?", "the user message");
      },
    },
    {
      name: "terminal done discipline: exactly one done, nothing after",
      run: async () => {
        const model = await makeModel([{ reasoning: ["thinking"], deltas: ["Hel", "lo"], reply: { text: "Hello", toolCalls: [] } }], () => {});
        const seen: ModelDelta[] = [];
        for await (const d of model([{ role: "user", turnId: "t_conf", text: "hi" }], [])) seen.push(d);
        const doneIdx = seen.findIndex((d) => d.type === "done");
        assert(doneIdx >= 0, "the stream must end with a done event");
        assert(seen.filter((d) => d.type === "done").length === 1, "exactly ONE done — done is terminal");
        assert(seen.slice(doneIdx + 1).length === 0, "nothing may follow done (the engine cancels there)");
        const done = seen[doneIdx] as Extract<ModelDelta, { type: "done" }>;
        assert(done.reply.text === "Hello", "done.reply is the authoritative assembled reply");
      },
    },
    {
      name: "delta forwarding: scripted reasoning/text deltas arrive, in order, before done",
      skip: opts.streaming === false,
      run: async () => {
        const model = await makeModel([{ reasoning: ["thinking"], deltas: ["Hel", "lo"], reply: { text: "Hello", toolCalls: [] } }], () => {});
        const seen: ModelDelta[] = [];
        for await (const d of model([{ role: "user", turnId: "t_conf", text: "hi" }], [])) seen.push(d);
        // judge only the deltas BEFORE the first done — done multiplicity is the
        // terminal-done scenario's defect, and each scenario isolates its own
        const doneIdx = seen.findIndex((d) => d.type === "done");
        assert(doneIdx >= 0, "the stream must reach a done event");
        const sequence = seen.slice(0, doneIdx).map((d) => (d.type === "done" ? "done" : `${d.type}:${d.text}`));
        assert(
          JSON.stringify(sequence) === JSON.stringify(["reasoning:thinking", "text:Hel", "text:lo"]),
          `the scripted deltas must be forwarded in order before done (got ${JSON.stringify(sequence)})`,
        );
      },
    },
    {
      name: "tool round-trip (empty assistant text + tool call)",
      run: async () => {
        const wires: unknown[] = [];
        const model = await makeModel([
          { reply: { text: "", toolCalls: [{ id: "call_1", name: "echo", input: { q: 1 } }] } },
          { reply: { text: "echoed 1", toolCalls: [] } },
        ], (w) => wires.push(w));
        const { wrapped, invocations } = instrument(model);
        assert((await turn(wrapped, [echoTool], { userText: "echo 1" })) === "echoed 1", "the turn must complete through the tool round");
        assert(invocations.length === 2, `the adapter must be invoked twice (got ${invocations.length})`);
        const call = invocations[0]!.dones[0]?.toolCalls[0];
        assert(call?.id === "call_1" && call.name === "echo", "the adapter must surface the scripted tool call id/name intact");
        // the SECOND wire request must carry the prior round back to the provider
        wireHas(wires, 1, "call_1", "the tool call id");
        wireHas(wires, 1, "echoed", "the tool RESULT content");
      },
    },
    {
      name: "parallel tool calls in one reply",
      run: async () => {
        const wires: unknown[] = [];
        const model = await makeModel([
          { reply: { text: "", toolCalls: [{ id: "c1", name: "echo", input: { a: 1 } }, { id: "c2", name: "add", input: { b: 2 } }] } },
          { reply: { text: "both done", toolCalls: [] } },
        ], (w) => wires.push(w));
        assert((await turn(model, [echoTool, addTool], { userText: "do both" })) === "both done", "the turn must complete with BOTH calls executed");
        // both results — the consecutive-tool-result folding case — must reach the wire
        wireHas(wires, 1, "echoed", "the first tool's result");
        wireHas(wires, 1, "sum", "the second tool's result");
      },
    },
    {
      name: "proactive trigger-role turn",
      run: async () => {
        const wires: unknown[] = [];
        const model = await makeModel([{ reply: { text: "summary sent", toolCalls: [] } }], (w) => wires.push(w));
        // dev.9 class: the transcript OPENS with a `trigger` msg — an adapter that only
        // maps user/assistant/tool throws, sends an invalid shape, or drops the seed
        assert((await turn(model, [], { userText: "summarize the day", trigger: { kind: "proactive", by: "cron:daily" } })) === "summary sent", "a trigger-seeded turn must complete");
        wireHas(wires, 0, "summarize the day", "the trigger seed text (mapped to a role the provider accepts)");
      },
    },
    {
      name: "multi-round tool chain replay",
      run: async () => {
        const wires: unknown[] = [];
        const model = await makeModel([
          { reply: { text: "step one", toolCalls: [{ id: "c1", name: "echo", input: { step: 1 } }] } },
          { reply: { text: "", toolCalls: [{ id: "c2", name: "echo", input: { step: 2 } }] } },
          { reply: { text: "chain done", toolCalls: [] } },
        ], (w) => wires.push(w));
        assert((await turn(model, [echoTool], { userText: "run the chain" })) === "chain done", "a two-round tool chain must complete");
        // mixed content: round one had text ALONGSIDE its tool call — the final wire
        // request must still carry both the text and every prior round's results
        wireHas(wires, 2, "step one", "round one's assistant text (text-plus-toolCall mixed content)");
        wireHas(wires, 2, "c2", "round two's call id");
      },
    },
    {
      name: "providerState round-trip",
      skip: opts.usesProviderState === false,
      run: async () => {
        const wires: unknown[] = [];
        const model = await makeModel([
          { reply: { text: "", toolCalls: [{ id: "c1", name: "echo", input: {}, providerState: "sig~conformance" }] } },
          { reply: { text: "ok", toolCalls: [] } },
        ], (w) => wires.push(w));
        const { wrapped, invocations } = instrument(model);
        assert((await turn(wrapped, [echoTool], { userText: "go" })) === "ok", "the turn must complete");
        // the adapter's own emit must carry the state (a wire mapping that drops it fails here — the id-smuggling hack #92 replaced)
        assert(invocations[0]!.dones[0]?.toolCalls[0]?.providerState === "sig~conformance", "the adapter must surface providerState on its emitted ToolCall");
        // and the REPLAY wire must hand it back to the provider verbatim
        wireHas(wires, 1, "sig~conformance", "the providerState on replay");
      },
    },
  ];

  const report: ConformanceReport = { passed: [], skipped: [], failed: [] };
  for (const s of scenarios) {
    if (s.skip) { report.skipped.push(s.name); continue; }
    try {
      await s.run();
      report.passed.push(s.name);
    } catch (err) {
      report.failed.push({ scenario: s.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

// A minimal EventSink for driving AgentSession in tests/conformance.
function memorySink(): EventSink {
  const subs = new Set<(e: TurnEvent) => void>();
  return {
    emit(e) { subs.forEach((cb) => { try { cb(e); } catch { /* a bad subscriber must not break emit */ } }); },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}
