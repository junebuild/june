// agent-config.ts — defineAgent and the defineAction→Tool bridge (pure).
//
// An agent is assembled from June's existing primitives: its tools ARE
// `defineAction`s (the same objects that are UI server actions and /mcp tools),
// so a directory of actions becomes an agent with no new tool concept. Directory
// discovery (scanning an agent/ folder) lives in @junejs/server (fs = host);
// this module is the pure config layer it produces.

import type { AnyAction } from "./agent";
import type { Tool, ToolSpec } from "./agent-runtime";
import type { ConnectionReport } from "./connections";

// A skill: a named procedure loaded on demand (progressive disclosure). The
// system prompt lists them; the model pulls a body via the read_skill tool.
export type Skill = { name: string; description: string; body: string };

// A channel is an INBOUND edge — how a message reaches the agent: an HTTP
// endpoint, a Slack/Crisp webhook, a CLI. It maps the inbound message to a
// session, runs a durable turn via ctx.run, and (for chat platforms) posts the
// reply back out. Web-standard (Request→Response, no node:*) so it runs on both
// native and edge targets.
export type ChannelContext = {
  agent: AgentDefinition;
  run: (message: string, opts?: { session?: string; turnId?: string }) => Promise<string>;
  // Extend the invocation past the fast-ACK response so a webhook's background work
  // (run the turn, post the reply out-of-band) reliably completes. On the edge the
  // host passes workerd's `ctx.waitUntil` — without it, a promise left floating after
  // the 200 ACK can be killed when the isolate is reclaimed. Absent on native (Node
  // keeps floating promises alive), so a channel must treat it as optional.
  waitUntil?: (p: Promise<unknown>) => void;
};
export type Channel = {
  name: string;
  // one-shot input source (e.g. cli): run once at startup
  start?: (ctx: ChannelContext) => Promise<void> | void;
  // a general fetch handler (e.g. http: POST /message + /mcp)
  fetch?: (ctx: ChannelContext) => (req: Request) => Promise<Response>;
  // a webhook mounted at `path` (e.g. Slack/Crisp): verify signature, ACK fast,
  // run the turn, post the reply out-of-band
  path?: string;
  webhook?: (req: Request, ctx: ChannelContext) => Promise<Response>;
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
export type ChannelFactory = (env: unknown) => Channel;

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
  // report of external connections wired in (their tools are already in `tools`)
  connections: ConnectionReport[];
};

// Bridge a `defineAction` into a runtime Tool. The action's run(input, ctx) is
// invoked with an empty identity ctx (data is ambient — `import { db }`); the
// runtime threads real identity later. Sync/async is PRESERVED so the engine
// classifies it right: an async action (the common case — it awaits the ambient
// db) becomes an at-least-once remote tool; a sync action stays an exactly-once
// local tool.
export function actionToTool(action: AnyAction): Tool {
  const spec: ToolSpec = { name: action.id, description: action.description, input: action.input };
  const isAsync = action.run.constructor.name === "AsyncFunction";
  return isAsync
    ? { spec, run: async (input: unknown) => action.run(input, {}) }
    : { spec, run: (input: unknown) => action.run(input, {}) };
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
  connections?: ConnectionReport[];
}): AgentDefinition {
  const skills = config.skills ?? [];
  const tools: Tool[] = (config.tools ?? []).map((t) => (isTool(t) ? t : actionToTool(t)));
  if (skills.length) tools.push(readSkillTool(skills));
  return {
    name: config.name,
    model: config.model,
    description: config.description,
    instructions: config.instructions ?? "",
    tools,
    skills,
    channels: config.channels ?? [],
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
export function buildSystemPrompt(agent: AgentDefinition): string {
  let prompt = agent.instructions.trim();
  if (agent.skills.length) {
    prompt += "\n\n## Available skills (call read_skill to load one)\n";
    prompt += agent.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  }
  return prompt;
}
