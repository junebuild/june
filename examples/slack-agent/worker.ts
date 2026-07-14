// A deployable Slack agent on Cloudflare (Workers + Durable Objects). It shows the
// TWO sides of one `slackChannel`:
//   • INBOUND  — the signed Events API webhook, mounted on the Worker, routes each
//                message to the per-session Durable Object (one DO = one thread).
//   • OUTBOUND — the channel's capability tools (slack_read_thread /
//                slack_list_reactions / slack_resolve_user), handed to the agent so
//                it can read a thread's replies and see who reacted with which emoji.
// The same factory produces both, so the bot token / signing secret are declared once.
//
//   wrangler dev     → http://localhost:8787   (offline: scripted model, no secrets)
//   wrangler deploy  → live                     (set the secrets below for real Slack)
//
// Local smoke test (no Slack, no key) — POST a chat turn straight to the DO:
//   curl -sX POST localhost:8787/message -d '{"message":"hello","session":"s1"}'

import { DurableObject } from "cloudflare:workers";
import { AgentDurableObject, durableAgentSurface, durableChannelSurface, type DurableObjectNamespace } from "@junejs/server/agent-durable";
import { anthropic } from "@junejs/core/agent-models";
import { slackChannel } from "@junejs/core/channels";
import type { Model, ModelReply, Msg } from "@junejs/core/agent-runtime";

type Env = {
  AGENT: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  // Slack secrets — present only in the worker env (never at module scope on
  // workerd), which is why the channel below is built from `env` at request time.
  SLACK_SIGNING_SECRET?: string; // verifies inbound webhooks
  SLACK_BOT_TOKEN?: string;      // xoxb-… — authenticates the read tools' API calls
};

// One factory, both edges. Built from env wherever env is available: in the DO
// constructor (for `.tools()`) and in the Worker fetch (for the webhook).
//
// By default `events` is ["message", "app_mention"] (a text turn). To have the agent
// react in real time when someone adds an emoji, opt in:
//   events: ["message", "app_mention", "reaction_added"], botUserId: env.SLACK_BOT_USER_ID
// (botUserId guards the bot's own reactions from looping — get it from auth.test, or the
// `U…` in your app's OAuth page.) The agent can react back with the slack_add_reaction tool.
const makeSlack = (env: Env) =>
  slackChannel({
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",
    botToken: env.SLACK_BOT_TOKEN ?? "",
    // Render the turn LIVE: the answer tokens stream into ONE Slack message via the native
    // chat.startStream → appendStream → stopStream API as the model produces them. The edge
    // DO streams TurnEvents (incl. message.delta) as SSE; durableChannelSurface exposes them
    // as ctx.runStream, which this consumes. Needs the chat:write scope.
    stream: true,
    // The agent-era typing indicator: an "is thinking…" line under the composer while the
    // turn runs (assistant.threads.setStatus). Slack clears it when the reply streams in.
    // Needs the app's Agents & AI Apps feature; without it the call fails harmlessly.
    status: "is thinking…",
  });

const INSTRUCTIONS = [
  "You are a helpful assistant living in a Slack thread.",
  "When a message refers to the conversation ('what did people say?', 'who reacted?', 'summarize this thread'),",
  "use slack_read_thread to read the replies and slack_list_reactions to see which emoji each person added.",
  "Resolve user ids to names with slack_resolve_user before mentioning anyone.",
  "Reply in ONE concise Slack message.",
].join(" ");

// Offline fallback so `wrangler dev` runs with no secrets — the Model seam is
// pluggable, so the whole durable loop works deterministically without a key. It
// does not call the Slack tools (there's no workspace offline); swap in anthropic()
// with a real bot token to see the agent actually read threads and reactions.
const scripted: Model = async (msgs: Msg[]): Promise<ModelReply> => {
  const last = [...msgs].reverse().find((m) => m.role === "user");
  const text = last && last.role === "user" ? last.text : "";
  return { text: `(offline) You said: ${text}. Set SLACK_BOT_TOKEN + ANTHROPIC_API_KEY to let me read this thread.`, toolCalls: [] };
};

// One DO = one Slack thread (session `slack:{channel}:{thread}`). The agent's tools
// ARE the slack channel's capability tools — the SAME slackChannel that serves the
// webhook below. Real Claude when a key is set, else the offline model.
export class JuneSlackDO extends DurableObject<Env> {
  #agent = new AgentDurableObject(this.ctx, {
    name: "slack-helper",
    tools: [],
    // The DO builds the channel's capability tools from ITS OWN env (a tool's run
    // closure can't cross the worker→DO RPC). Pass the same factory you mount below.
    channels: [makeSlack],
    env: this.env,
    instructions: INSTRUCTIONS,
    // Optional: per-source system overlay — the model learns, from the real (unforgeable)
    // event source, that this turn came from Slack. No userText marker needed.
    channelInstructions: { slack: "This turn was triggered from Slack; keep replies to one short Slack message." },
    model: this.env.ANTHROPIC_API_KEY
      ? anthropic({ model: "claude-opus-4-8", apiKey: this.env.ANTHROPIC_API_KEY })
      : scripted,
  });
  fetch(req: Request): Promise<Response> {
    return this.#agent.fetch(req);
  }
}

// The Worker routes two inbound edges to the per-session DO, both via June helpers:
//   • POST /message         → durableAgentSurface (a plain chat endpoint, for local
//                             smoke-testing without Slack)
//   • POST /channels/slack  → durableChannelSurface (verify the Slack signature with
//                             the env secret, derive the thread session, run the turn,
//                             post the reply back via chat.postMessage on waitUntil).
// Point your Slack app's Event Subscriptions Request URL at .../channels/slack.
export default {
  fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const chat = durableAgentSurface(() => env.AGENT, { agentName: "slack-helper", chatPath: "/message" });
    const channels = durableChannelSurface(() => env.AGENT, {
      agentName: "slack-helper",
      channels: [makeSlack],
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
    });
    return chat(req)
      .then((r) => r ?? channels(req))
      .then((r) => r ?? new Response("POST /message {\"message\",\"session?\"} or Slack events at /channels/slack", { status: 404 }));
  },
};
