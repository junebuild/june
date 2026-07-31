// agent-config.ts — defineAgent and the defineAction→Tool bridge (pure).
//
// An agent is assembled from June's existing primitives: its tools ARE
// `defineAction`s (the same objects that are UI server actions and /mcp tools),
// so a directory of actions becomes an agent with no new tool concept. Directory
// discovery (scanning an agent/ folder) lives in @junejs/server (fs = host);
// this module is the pure config layer it produces.

import type { AnyAction } from "./agent";
import type { InboundEvent, ProactiveTrigger, Tool, ToolContext, ToolSpec, TurnEvent } from "./agent-runtime";
import { connectAll, type Connection, type ConnectionReport } from "./connections";

// InboundEvent's canonical definition lives in agent-runtime (ToolContext carries it);
// re-export from here — where Channel/ChannelContext live — so channel authors import
// the envelope alongside the types they build on.
export type { InboundEvent } from "./agent-runtime";

// A skill: a named procedure loaded on demand (progressive disclosure). The
// system prompt lists them; the model pulls a body via the read_skill tool.
// `whenToUse` (frontmatter `when-to-use`) rides the index line so the model can
// decide whether to load the body without spending a tool call to find out.
export type Skill = { name: string; description: string; whenToUse?: string; body: string };

// Parse a skill file: optional YAML-ish frontmatter (--- \n key: value \n ---)
// then the body. Falls back to the first non-empty line (minus a leading "# ")
// as the description. Frontmatter keys may be hyphenated ("when-to-use") —
// authored prose follows document conventions, not identifier rules. Pure, so
// native discovery (fs) and a compiled agent module (edge) parse identically.
export function parseSkill(name: string, text: string): Skill {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const front = text.slice(3, end);
      const body = text.slice(end + 4).replace(/^\s*\n/, "");
      const meta: Record<string, string> = {};
      for (const line of front.split("\n")) {
        const m = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
        if (m) meta[m[1]!] = m[2]!;
      }
      const whenToUse = meta["when-to-use"] ?? meta.whenToUse;
      return { name: meta.name ?? name, description: meta.description ?? "", ...(whenToUse ? { whenToUse } : {}), body };
    }
  }
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return { name, description: firstLine.replace(/^#\s*/, ""), body: text };
}

// A channel is an INBOUND edge — how a message reaches the agent: an HTTP
// endpoint, a Slack/Crisp webhook, a CLI. It maps the inbound message to a
// session, runs a durable turn via ctx.run, and (for chat platforms) posts the
// reply back out. Web-standard (Request→Response, no node:*) so it runs on both
// native and edge targets.
export type ChannelContext = {
  agent: AgentDefinition;
  // `event` is additive: existing callers pass only the text; a channel that has a
  // normalized envelope threads it through so the turn (and its tools) can see the
  // actor/kind/reaction. Batch 1 defines the seam; the Slack/Crisp adapters and the
  // durable /turn edge start populating it in the following batches.
  //
  // `replace` (#129, on run/runStream/runDetached/runDelivered): cancel-and-replace
  // (debounce) — every unfinished turn on the session is superseded at its next
  // checkpoint boundary (it settles as cancelled, emitting turn.cancelled), then this
  // turn runs. A SUSPENDED turn is never cancelled by replace: starting over a pending
  // approval still rejects. Opt-in per call — a channel where several participants ask
  // independent questions in one thread must NOT blanket-replace.
  run: (message: string, opts?: { session?: string; turnId?: string; event?: InboundEvent; trigger?: ProactiveTrigger; replace?: boolean }) => Promise<string>;
  // The LIVE variant: run a turn and get its TurnEvent stream, so a channel can render the
  // turn as it happens (typing indicator, progressive edits, tool status) instead of only
  // posting the final text. Optional — a host that can't stream (or a channel that doesn't
  // render) uses `run`. The host provides it on targets that support streaming (the edge
  // Durable Object over SSE); a channel checks for it and falls back to `run`.
  // `trigger` marks an agent-INITIATED (proactive) turn — no inbound event; the turn opens with a
  // `trigger`-role seed attributed to `by`. Passed by receive() (§9); omitted for inbound turns.
  // Proactive-only by type: inbound is derived from `event`, resume is engine-internal.
  runStream?: (message: string, opts?: { session?: string; turnId?: string; event?: InboundEvent; trigger?: ProactiveTrigger; replace?: boolean }) => AsyncIterable<TurnEvent>;
  // FIRE-AND-FORGET (#77): start a turn and resolve as soon as it is durably ACCEPTED —
  // never hold the caller open for the result. For shadow/observe work (an assessment
  // ledger, mirroring) the reply is dropped anyway, and on the edge awaiting it bounds
  // turn duration by the EDGE isolate's post-ACK lifetime (the waitUntil ceiling kills
  // long multi-round turns) instead of the Durable Object's own — a DO stays alive
  // while it has pending work. A detached turn has no live consumer: failures surface
  // only via the host's turn-failure logging / onTurnError hook. Optional, like
  // runStream: the host provides it where detachment is meaningful.
  runDetached?: (message: string, opts?: { session?: string; turnId?: string; event?: InboundEvent; trigger?: ProactiveTrigger; replace?: boolean }) => Promise<{ turnId: string }>;
  // DELIVERED (runDetached's reply-bearing sibling): start the turn, resolve once it is
  // durably ACCEPTED — and have the TURN'S HOST render the reply through the channel's own
  // deliver() (same renderer as the inbound path), instead of a consumer at the edge. On the
  // Durable Object target the turn AND its rendering then run under the DO's own lifetime, so
  // a reply-bearing turn is no longer bounded by the edge waitUntil ceiling — the failure mode
  // where a long multi-round turn (and its Slack stream) was cancelled ~30s after the ACK,
  // silently posting nothing. Requires the host to have the channel (event.source names it)
  // wired where the turn runs (DoAgentDef.channels); a host that can't deliver rejects with
  // DeliverUnsupportedError BEFORE starting the turn, so the channel may safely fall back to
  // consumer-side rendering (ctx.runStream) without double-running the turn. Optional, like
  // runStream: the host provides it where host-side delivery is meaningful.
  runDelivered?: (message: string, opts?: { session?: string; turnId?: string; event?: InboundEvent; trigger?: ProactiveTrigger; replace?: boolean }) => Promise<{ turnId: string }>;
  // Resume a turn that was parked by ctx.requestInput (HITL): provide the answer and get the
  // continuation's TurnEvent stream, so a channel can render the resumed turn to completion.
  // `by` is the VERIFIED resumer identity (e.g. the user id from a signature-checked Slack
  // interaction) — the engine enforces it against the request's answererId. Optional, like
  // runStream: provided on streaming targets (the edge Durable Object).
  resumeStream?: (opts: { session?: string; turnId: string; inputId: string; input: unknown; by?: string }) => AsyncIterable<TurnEvent>;
  // DELIVERED resume (the reply-bearing sibling of resumeStream, mirroring runDelivered):
  // apply the human's answer and have the TURN'S HOST render the continuation through the
  // channel's own deliverResume() — 202 on acceptance, nothing held open, so a long
  // continuation escapes the edge waitUntil ceiling exactly like a delivered turn.
  // `source` names the channel whose deliverResume renders (the caller passes its own
  // Channel.name). Rejections keep their meaning: a host that cannot deliver refuses with
  // DeliverUnsupportedError BEFORE applying the input (safe to fall back to resumeStream
  // without double-answering); an engine rejection (unauthorized clicker, stale/double
  // click) surfaces as an ordinary error exactly as resumeStream's first pull would.
  resumeDelivered?: (opts: { session?: string; turnId: string; inputId: string; input: unknown; by?: string; source: string; target: ResumeDeliveryTarget }) => Promise<{ turnId: string }>;
  // SESSION RESET (#129): terminally retire a session's accumulated history — unfinished
  // turns are superseded, then messages/steps/status are ARCHIVED under the session's
  // current generation and the live state starts fresh (empty transcript, no initiator,
  // any stale suspended park cleared). The session's address is unchanged (one DO is one
  // session); `previousSession` is the audit handle naming the archived generation
  // (`<session>#g<N>` — the rows live on in the store's archive tables). Optional, like
  // runStream: provided where the host's store supports archival.
  resetSession?: (opts?: { session?: string }) => Promise<{ previousSession: string; generation: number }>;
  // Extend the invocation past the fast-ACK response so a webhook's background work
  // (run the turn, post the reply out-of-band) reliably completes. On the edge the
  // host passes workerd's `ctx.waitUntil` — without it, a promise left floating after
  // the 200 ACK can be killed when the isolate is reclaimed. Absent on native (Node
  // keeps floating promises alive), so a channel must treat it as optional.
  waitUntil?: (p: Promise<unknown>) => void;
  // The app's resolved services bag — the SAME shape `currentServices()` gives a turn,
  // but reachable from a channel HOOK (onEvent / on[kind]), which runs at the edge OUTSIDE
  // the Durable Object and so can't read the DO's ambient scope. The host resolves it from
  // the same factory the DO uses (see durableChannelSurface/mountAgent `services`) so an
  // observer writes via `ctx.services.feedback.record(...)` instead of re-plumbing bindings.
  // Opaque here (the app types it at the read), like RequestScope.services.
  services?: unknown;
};

// runDelivered's capability rejection: the turn's host cannot render this turn through a
// channel deliver() — the channel isn't wired where the turn runs (e.g. DoAgentDef.channels
// omits it) or it has no deliver(). Thrown BEFORE the turn starts (that ordering is the
// contract), so a channel catching THIS error may fall back to consumer-side rendering
// (ctx.runStream) knowing it won't double-run the turn. Any other runDelivered rejection is
// ambiguous — the turn may already be running — and must NOT trigger a re-run fallback.
export class DeliverUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliverUnsupportedError";
  }
}
// Where a proactive turn's output is posted when there's NO inbound webhook to reply to
// (§9). Platform-agnostic: `channelId` is the destination (a Slack channel, a Crisp
// conversation's website), `threadId` optionally threads it. deliver() renders a turn's
// event stream to this target with the SAME renderer the inbound path uses.
// recipientUserId/recipientTeamId are Slack-specific: chat.startStream requires them for ANY
// channel stream — even in-thread (live-verified 2026-07-15: missing_recipient_team_id) — so a
// proactive channel delivery should supply who the stream is for; other channels ignore them.
// Without them the renderer still degrades gracefully to chat.postMessage.
export type DeliveryTarget = { channelId: string; threadId?: string; recipientUserId?: string; recipientTeamId?: string };

// Where a RESUMED turn's continuation renders: the Approve/Deny prompt message itself.
// Unlike DeliveryTarget (a thread to post into), a resume updates an EXISTING message in
// place — `messageTs` names it — replacing the buttons with progress and then the outcome.
export type ResumeDeliveryTarget = { channelId: string; threadId?: string; messageTs: string };

// What channel.post sends (#89): plain text, or the object form carrying platform
// blocks (Slack Block Kit) with a `text` notification fallback. Channels without a
// block concept (Crisp) accept the object form but require `text`.
export type PostContent = string | { text?: string; blocks?: unknown[] };
// The sent message's identity — enough to index it (record a (channel, ts) →
// judgment row) and to resolve later interactions/reactions back to it. `ts` is the
// platform's message key: Slack's message ts, Crisp's fingerprint (stringified).
export type PostedMessage = { channelId: string; threadId?: string; ts: string };

export type Channel = {
  name: string;
  // one-shot input source (e.g. cli): run once at startup
  start?: (ctx: ChannelContext) => Promise<void> | void;
  // OUTBOUND, agent-initiated delivery (§9): render a proactive turn's event stream to a
  // target with no inbound event to reply to (a scheduled nudge, a cross-channel hand-off).
  // Same renderer as the inbound path — progressive edits, HITL prompts, final text. Paired
  // with the top-level receive() which starts the proactive turn and feeds its stream here.
  // `session` names the turn's session so an HITL prompt can route its resume back to it —
  // a proactive session is caller-chosen and NOT derivable from the target thread.
  deliver?: (target: DeliveryTarget, events: AsyncIterable<TurnEvent>, opts?: { session?: string }) => Promise<void>;
  // Render a RESUMED turn's continuation into the Approve/Deny prompt message (progress →
  // outcome / failure / next approval). The sibling of deliver() for the HITL resume leg:
  // the turn's host invokes it (via /resume?deliver=1) so a long continuation runs under
  // the host's lifetime instead of the webhook isolate's post-ACK grace.
  deliverResume?: (target: ResumeDeliveryTarget, events: AsyncIterable<TurnEvent>, opts?: { session?: string }) => Promise<void>;
  // DETERMINISTIC outbound post (#89): send one app-authored message (no LLM, no
  // stream) over the channel's own auth/transport and return its identity, so the
  // app can index it and resolve later reactions/clicks back to it. The dual of
  // deliver (which renders a TURN's stream). Unlike the reply path (best-effort),
  // post throws loudly on a platform error — the app initiated it and must know.
  post?: (target: DeliveryTarget, content: PostContent) => Promise<PostedMessage>;
  // a general fetch handler (e.g. http: POST /message + /mcp)
  fetch?: (ctx: ChannelContext) => (req: Request) => Promise<Response>;
  // a webhook mounted at `path` (e.g. Slack/Crisp): verify signature, ACK fast,
  // run the turn, post the reply out-of-band
  path?: string;
  webhook?: (req: Request, ctx: ChannelContext) => Promise<Response>;
  // OUTBOUND capabilities this channel gives the agent, as Tools merged into
  // `agent.tools` by defineAgent. This is the second channel seam: a channel is no
  // longer just "text in → text out" — it can also let the agent act on the platform
  // (read a Slack thread's replies, list who reacted with which emoji, resolve a user
  // id to a name, post/react back). Secrets (bot token) are captured in the factory
  // closure, so the returned Tools are already authenticated. Kept a thunk so the
  // tool list is built lazily at assembly time, mirroring `webhook`/`fetch`.
  tools?: () => Tool[];
};
export function defineChannel(channel: Channel): Channel {
  return channel;
}

// A channel module may default-export the Channel directly OR a factory of it. The
// factory form exists for workerd: platform secrets/bindings live only in `env`
// inside an invocation, never at module top-level, so a channel needing a signing
// secret can't be fully built where it's declared. `(env) => crispChannel({ signingSecret:
// env.CRISP_SIGNATURE_SECRET, ... })` defers construction to request time. On native,
// env is `process.env` (available at load), so the plain form still works — this is
// purely additive. The host resolves it once per isolate (env is stable per isolate).
//
// `env` is `any`, not `unknown`, on purpose: the app owns the env shape (its worker
// bindings), so a factory is written `(env: MyEnv) => …` and reads `env.MY_SECRET`
// directly. `unknown` would force a cast on every access AND — because function
// params are contravariant under strictFunctionTypes — make a typed `(env: MyEnv) =>
// Channel` un-assignable to this type. `any` in this one contravariant position lets
// apps supply a precisely-typed factory; the only untyped surface is the env bag,
// which is inherently untyped platform data the host just passes through.
export type ChannelFactory = (env: any) => Channel;

// Resolve a discovered channel to a concrete Channel, calling the factory with env.
export function resolveChannel(channel: Channel | ChannelFactory, env: unknown): Channel {
  return typeof channel === "function" ? channel(env) : channel;
}

// What `agent.ts` default-exports in the directory convention (the rest —
// instructions/tools/skills — is discovered from sibling files).
export type AgentConfigFile = {
  name: string;
  model?: string;
  description?: string;
  instructions?: string;
};

// A fully-assembled agent, ready to mount on a runtime (tools already adapted).
export type AgentDefinition = {
  name: string;
  model?: string;
  description?: string;
  instructions: string;
  tools: Tool[];
  skills: Skill[];
  channels: Channel[];
  // Per-channel-source system overlays. When a turn's InboundEvent.source (e.g. "slack")
  // matches a key, that text is appended to the system prompt for that turn — so ONE
  // shared agent can branch its behavior by the real, unforgeable inbound source instead
  // of a userText marker. Applied by the runtime (see AgentSession/withSystem).
  channelInstructions?: Record<string, string>;
  // report of external connections wired in (their tools are already in `tools`)
  connections: ConnectionReport[];
};

// Bridge a `defineAction` into a runtime Tool. The action's run(input, ctx)
// receives the TURN's identity: ToolContext.principal (resolved by a channel
// identity seam) maps onto ActionContext.user — the same field a UI POST or
// /mcp call carries — so ONE authorization check inside an action covers every
// dispatch path. Data stays ambient (`import { db }`), never on ctx. Sync/async
// is PRESERVED so the engine classifies it right: an async action (the common
// case — it awaits the ambient db) becomes an at-least-once remote tool; a
// sync action stays an exactly-once local tool. `requiresPrincipal` rides
// along so the turn engine hides the tool from anonymous turns.
export function actionToTool(action: AnyAction): Tool {
  const spec: ToolSpec = { name: action.id, description: action.description, input: action.input };
  const isAsync = action.run.constructor.name === "AsyncFunction";
  const toActionCtx = (ctx?: ToolContext) => (ctx?.principal ? { user: ctx.principal } : {});
  const tool: Tool = isAsync
    ? { spec, run: async (input: unknown, ctx?: ToolContext) => action.run(input, toActionCtx(ctx)) }
    : { spec, run: (input: unknown, ctx?: ToolContext) => action.run(input, toActionCtx(ctx)) };
  if (action.requiresPrincipal) tool.requiresPrincipal = true;
  return tool;
}

function isTool(x: AnyAction | Tool): x is Tool {
  return "spec" in x;
}

// A built-in tool that pulls a skill's full text on demand (the progressive-
// disclosure pattern). Kept a plain Tool, not a registered defineAction, so many
// agents don't collide on one "read_skill" id in the global ACTION_REGISTRY.
export function readSkillTool(skills: Skill[]): Tool {
  const byName = new Map(skills.map((s) => [s.name, s] as const));
  return {
    spec: {
      name: "read_skill",
      description: "Load the full step-by-step text of a named skill before doing a complex task.",
      input: { type: "object", properties: { name: { type: "string", description: "The skill name" } }, required: ["name"] },
    },
    run: (input: { name: string }) => {
      const s = byName.get(input.name);
      return s ? { name: s.name, body: s.body } : { error: `unknown skill: ${input.name}` };
    },
  };
}

// Assemble an agent from config + tools (defineActions or Tools) + skills. Used
// directly for a programmatic agent, and by @junejs/server's directory discovery
// (which fills instructions/tools/skills from the filesystem). If any skills are
// present, the read_skill tool is added automatically.
export function defineAgent(config: {
  name: string;
  model?: string;
  description?: string;
  instructions?: string;
  tools?: (AnyAction | Tool)[];
  skills?: Skill[];
  channels?: Channel[];
  channelInstructions?: Record<string, string>;
  connections?: ConnectionReport[];
}): AgentDefinition {
  const skills = config.skills ?? [];
  const channels = config.channels ?? [];
  const tools: Tool[] = (config.tools ?? []).map((t) => (isTool(t) ? t : actionToTool(t)));
  // Merge each channel's OUTBOUND capabilities (see Channel.tools) into the agent's
  // tools — so mounting the Slack channel also gives the agent slack_read_thread /
  // slack_list_reactions / … with no separate wiring. Added before read_skill so the
  // skill tool stays last (cosmetic, matches the prior ordering contract in tests).
  for (const c of channels) if (c.tools) tools.push(...c.tools());
  if (skills.length) tools.push(readSkillTool(skills));
  // Fail fast on a duplicate tool name. The engine dispatches by name (tools.find), so a
  // collision — two channels/connections exposing the same id, or a channel tool shadowing
  // an app tool — would silently bind to the first and make behavior order-dependent. As
  // agents accrue more channels this gets likelier; surface it at assembly, not at runtime.
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.spec.name)) {
      throw new Error(`defineAgent(${config.name}): duplicate tool name "${t.spec.name}" — two tools (or channel capabilities) share an id; rename one so dispatch is unambiguous.`);
    }
    seen.add(t.spec.name);
  }
  return {
    name: config.name,
    model: config.model,
    description: config.description,
    instructions: config.instructions ?? "",
    tools,
    skills,
    channels,
    channelInstructions: config.channelInstructions,
    connections: config.connections ?? [],
  };
}

// Build a Web-standard handler that dispatches to the agent's channels: a webhook
// channel by exact `path`, then any `fetch` channels (first non-404 wins).
// Returns `null` when no channel claims the request, so it composes as a
// fall-through surface inside June's router (and standalone servers treat null as
// 404). Pure — the caller supplies `ctx.run` (the bridge to a runtime), so this
// works identically on native and edge.
export function channelFetch(agent: AgentDefinition, ctx: ChannelContext): (req: Request) => Promise<Response | null> {
  return channelDispatch(agent.channels, ctx);
}

// The channel-dispatch core, over a plain channel list (not an AgentDefinition) so
// the edge surface can drive it with channels resolved from env — no need to fake a
// whole agent. A webhook channel matches by exact `path`; then `fetch` channels get
// first-non-404 wins; `null` when nothing claims the request (fall through).
export function channelDispatch(channels: Channel[], ctx: ChannelContext): (req: Request) => Promise<Response | null> {
  const webhooks = channels.filter((c) => c.path && c.webhook);
  const fetchers = channels.filter((c) => c.fetch).map((c) => c.fetch!(ctx));
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    for (const c of webhooks) if (url.pathname === c.path) return c.webhook!(req, ctx);
    for (const f of fetchers) {
      const res = await f(req);
      if (res.status !== 404) return res; // first channel that handles the route wins
    }
    return null; // not an agent route — fall through
  };
}

// The full system prompt = authored instructions + a one-line index of skills,
// so the model knows what it can pull on demand. (Consumed by the model adapter.)
// Structural param: assembleDurable composes the same prompt without a full
// AgentDefinition in hand.
export function buildSystemPrompt(agent: Pick<AgentDefinition, "instructions" | "skills">): string {
  let prompt = agent.instructions.trim();
  if (agent.skills.length) {
    prompt += "\n\n## Available skills (call read_skill to load one)\n";
    prompt += agent.skills.map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` — when to use: ${s.whenToUse}` : ""}`).join("\n");
  }
  return prompt;
}

// The RAW, runtime-agnostic shape of an agent directory — what native discovery
// (@junejs/server discoverAgent, fs) and edge compilation (a generated
// _agent.gen.ts) both produce BEFORE assembly. Channels stay unresolved (Channel
// or (env)=>Channel factory) because the two targets resolve env at different
// times: native at discovery (process.env), a Durable Object per-isolate (its
// own env). Connections stay definitions for the same reason — connectAll is
// network I/O that must run where (and when) the agent runs.
export type AgentModule = {
  config: AgentConfigFile;
  // Raw instructions markdown; empty → fall back to config.instructions.
  instructions: string;
  tools: (AnyAction | Tool)[];
  skills: Skill[];
  // Keyed by the channel file's basename — the same key a matching
  // channelInstructions overlay uses.
  channels: Record<string, Channel | ChannelFactory>;
  // Source-keyed system overlays, from channels/<source>.md.
  channelInstructions: Record<string, string>;
  connections: Connection[];
};

// Assemble an AgentModule for a NATIVE host: resolve channel factories against
// env (process.env on Node), wire connections (network I/O), and hand everything
// to defineAgent. This is the single assembly path — discoverAgent (fs) and a
// compiled _agent.gen.ts (edge/CI) both go through here, so the two runtimes
// cannot drift on how a directory becomes an agent.
export async function assembleAgent(mod: AgentModule, env?: unknown): Promise<AgentDefinition> {
  const channels = Object.values(mod.channels).map((c) => resolveChannel(c, env));
  const { actions, report } = mod.connections.length
    ? await connectAll(mod.connections)
    : { actions: [] as AnyAction[], report: [] as ConnectionReport[] };
  return defineAgent({
    name: mod.config.name,
    model: mod.config.model,
    description: mod.config.description,
    instructions: mod.instructions || (mod.config.instructions ?? ""),
    tools: [...mod.tools, ...actions],
    skills: mod.skills,
    channels,
    channelInstructions: Object.keys(mod.channelInstructions).length ? mod.channelInstructions : undefined,
    connections: report,
  });
}

// Assemble an AgentModule for the DURABLE (edge) target: the DoAgentDef-shaped
// pieces an app spreads into its DO shell —
//
//   new AgentDurableObject(this.ctx, {
//     ...assembleDurable(agentModule),
//     model: makeModel(this.env), env: this.env, services: makeServices(this.env),
//   })
//
// The differences from assembleAgent are the edge contract, not drift: channels
// pass through UNRESOLVED (the DO resolves them with ITS env and merges their
// capability tools in-isolate — a tool's run closure can't cross the worker→DO
// RPC), and connections are omitted (wiring them is I/O that belongs to the DO's
// lifecycle, not assembly — the lazy-connect seam is a follow-up). Skills mount
// the same way defineAgent mounts them natively: read_skill + the prompt index.
export function assembleDurable(mod: AgentModule): {
  name: string;
  tools: Tool[];
  instructions: string;
  channelInstructions?: Record<string, string>;
  channels: (Channel | ChannelFactory)[];
} {
  const tools: Tool[] = mod.tools.map((t) => (isTool(t) ? t : actionToTool(t)));
  if (mod.skills.length) tools.push(readSkillTool(mod.skills));
  // Same fail-fast as defineAgent: dispatch is by name, so a collision would
  // silently bind to the first tool and make behavior order-dependent.
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.spec.name)) {
      throw new Error(`assembleDurable(${mod.config.name}): duplicate tool name "${t.spec.name}" — rename one so dispatch is unambiguous.`);
    }
    seen.add(t.spec.name);
  }
  const instructions = buildSystemPrompt({ instructions: mod.instructions || (mod.config.instructions ?? ""), skills: mod.skills });
  return {
    name: mod.config.name,
    tools,
    instructions,
    ...(Object.keys(mod.channelInstructions).length ? { channelInstructions: mod.channelInstructions } : {}),
    channels: Object.values(mod.channels),
  };
}
