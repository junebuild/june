// A Slack agent that shows the round-2 channel hooks working together — the "channel
// is a routing table" shape:
//   • @mention  → a Q&A TURN (respondTo) → the model answers, with the Slack read tools
//   • emoji     → a DETERMINISTIC write via on[kind] + ctx.services — NO LLM, no reply
// One `makeServices` factory feeds both the DO turn and the edge hooks (one DI story).
//
//   wrangler dev     → http://localhost:8787   (offline: scripted model, no secrets)
//   curl -sX POST localhost:8787/message -d '{"message":"hi","session":"s1"}'
//   curl -s localhost:8787/feedback          → reactions recorded by the edge hook

import { DurableObject } from "cloudflare:workers";
import { AgentDurableObject, durableAgentSurface, durableChannelSurface, type DurableObjectNamespace } from "@junejs/server/agent-durable";
import { anthropic } from "@junejs/core/agent-models";
import { slackChannel } from "@junejs/core/channels";
import type { InboundEvent, Model, Msg } from "@junejs/core/agent-runtime";

type Env = {
  AGENT: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_USER_ID?: string; // loop guard: the bot's own reactions don't record
};

// ── the app's services (userland domain) ──────────────────────────────────────
// `feedback.record` is called from the channel hook AT THE EDGE, and the same bag would
// be available to a turn tool inside the DO — one shape, one factory. In-memory here (a
// per-isolate array) to keep the example self-contained; in production `record` writes to
// D1/KV so the edge and the DO converge on shared state. The reaction path below is
// edge-only, so GET /feedback (also edge) observes exactly what the hook recorded.
type Feedback = { user?: string; reaction: string; itemTs: string; verb: "added" | "removed" };
const recorded: Feedback[] = [];
function makeServices(_env: Env) {
  return {
    feedback: {
      record(e: InboundEvent) {
        const f: Feedback = {
          user: e.user?.id,
          reaction: e.reaction?.name ?? "?",
          itemTs: e.reaction?.itemTs ?? e.ts,
          verb: e.kind === "reaction_removed" ? "removed" : "added",
        };
        recorded.push(f);
        console.log("[feedback]", JSON.stringify(f));
      },
    },
  };
}
type Services = ReturnType<typeof makeServices>;

// ── the channel: a routing table, no domain logic ─────────────────────────────
// `events` is DERIVED from respondTo + on keys → ["app_mention","reaction_added",
// "reaction_removed"]; no separate subscribe line to drift.
const makeSlack = (env: Env) =>
  slackChannel({
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",
    botToken: env.SLACK_BOT_TOKEN ?? "",
    botUserId: env.SLACK_BOT_USER_ID,
    respondTo: ["app_mention"], // mention → turn + reply
    on: {
      // typed, non-optional event, no demux — deterministic write, never an LLM turn
      reaction_added: (e, ctx) => (ctx.services as Services).feedback.record(e),
      reaction_removed: (e, ctx) => (ctx.services as Services).feedback.record(e),
    },
  });

const INSTRUCTIONS = "You answer Slack @mentions helpfully in ONE short message. If the question is about the thread, use slack_read_thread / slack_list_reactions.";

// Offline fallback so `wrangler dev` runs with no secrets.
const scripted: Model = async (msgs: Msg[]) => {
  const last = [...msgs].reverse().find((m) => m.role === "user");
  return { text: `(offline) You said: ${last && last.role === "user" ? last.text : ""}`, toolCalls: [] };
};

// One DO = one Slack thread. It builds the channel's capability tools from its own env
// (B) and gets the SAME services factory the edge uses (for any turn tool that needs it).
export class JuneSlackDO extends DurableObject<Env> {
  #agent = new AgentDurableObject(this.ctx, {
    name: "slack-feedback",
    tools: [],
    channels: [makeSlack],
    env: this.env,
    services: makeServices(this.env),
    instructions: INSTRUCTIONS,
    channelInstructions: { slack: "This turn was triggered from Slack; reply in one short Slack message." },
    model: this.env.ANTHROPIC_API_KEY
      ? anthropic({ model: "claude-opus-4-8", apiKey: this.env.ANTHROPIC_API_KEY })
      : scripted,
  });
  fetch(req: Request): Promise<Response> {
    return this.#agent.fetch(req);
  }
}

export default {
  fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(req.url);
    // inspect what the edge reaction hook recorded (this is the same isolate the hook ran in)
    if (url.pathname === "/feedback") return Promise.resolve(Response.json({ feedback: recorded }));

    const chat = durableAgentSurface(() => env.AGENT, { agentName: "slack-feedback", chatPath: "/message" });
    const channels = durableChannelSurface(() => env.AGENT, {
      agentName: "slack-feedback",
      channels: [makeSlack],
      env,
      // the edge hooks (on[kind]) get ctx.services from the SAME factory the DO uses
      services: (e) => makeServices(e as Env),
      waitUntil: ctx.waitUntil.bind(ctx),
    });
    return chat(req)
      .then((r) => r ?? channels(req))
      .then((r) => r ?? new Response('POST /message {"message","session?"} · Slack events at /channels/slack · GET /feedback', { status: 404 }));
  },
};
