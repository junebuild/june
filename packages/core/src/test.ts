// test.ts — the @junejs/core/test entry (#93): the scaffolding every June app's
// channel tests were re-implementing by hand (crisp-agent hand-rolled Slack HMAC
// signing three times, a fake ChannelContext, and a fake streaming host — and each
// re-implementation drifts as the real surfaces grow). Shipping the helpers INSIDE
// core keeps them in lockstep with the surfaces they fake by construction: a
// ChannelContext change lands in the same package version as the fake that mirrors
// it. Pure contract-layer code (zero node:*), like everything else in core.

import type { TurnEvent, TurnError, InputRequest, TurnTrigger } from "./agent-runtime";
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
