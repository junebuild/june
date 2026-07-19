// A deployable Cloudflare Worker: a durable agent on the edge, one Durable Object
// per session. Uses the real @junejs packages — the same AgentDurableObject +
// durableAgentSurface + durableChannelSurface that June's build will eventually
// generate for you. Until that codegen lands, this hand-written entry is the pattern.
//
//   wrangler dev     → http://localhost:8787   (offline: scripted model, no key)
//   wrangler deploy  → live                     (set ANTHROPIC_API_KEY for real Claude)
//
// Try it:
//   curl -sX POST localhost:8787/message -d '{"message":"order 3 widgets","session":"s1"}'

import { DurableObject } from "cloudflare:workers";
import { AgentDurableObject, durableAgentSurface, durableChannelSurface, type DurableObjectNamespace } from "@junejs/server/agent-durable";
import { anthropic } from "@junejs/core/agent-models";
import { crispChannel } from "@junejs/core/channels";
import { defineAction } from "@junejs/core/agent";
import { actionToTool } from "@junejs/core/agent-config";
import { replyStream, type Model, type ModelDelta, type Msg } from "@junejs/core/agent-runtime";

type Env = {
  AGENT: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  // Crisp secrets — present only in the worker env (never at module scope on
  // workerd), which is why the channel below is a `(env) => Channel` factory.
  CRISP_SIGNATURE_SECRET?: string;
  CRISP_IDENTIFIER?: string;
  CRISP_KEY?: string;
};

// A tool IS a defineAction. On the edge, tools are STATICALLY imported (fs
// discovery is a dev/build-time thing) — here inline for a self-contained example.
const createOrder = defineAction({
  id: "create_order",
  description: "Place an order for an item.",
  input: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } }, required: ["item"] },
  run: (input) => ({ orderId: 1, item: input.item, qty: input.qty ?? 1 }),
});
const tools = [actionToTool(createOrder)];
const INSTRUCTIONS = "You are an ordering assistant. Use create_order, then confirm the order number in one sentence.";

// Offline fallback so `wrangler dev` works with no API key — the Model seam is
// pluggable, so no MSW / HTTP interception is needed to run the whole loop
// deterministically. Swap in anthropic() the moment a key is present.
const scripted: Model = (msgs: Msg[]): AsyncIterable<ModelDelta> => {
  const placed = msgs.some((m) => m.role === "tool" && m.name === "create_order");
  if (!placed) return replyStream({ text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] });
  return replyStream({ text: "Done — order placed.", toolCalls: [] });
};

// One DO = one session. The app supplies this thin shell; it delegates to
// @junejs/server's AgentDurableObject (which runs the durable loop over
// ctx.storage.sql). Real Claude when a key is set, else the offline model.
export class JuneAgentDO extends DurableObject<Env> {
  #agent = new AgentDurableObject(this.ctx, {
    name: "ops",
    tools,
    // instructions live on the def; the runtime injects them as the system prompt
    // per turn (works for the real model AND the scripted fallback).
    instructions: INSTRUCTIONS,
    model: this.env.ANTHROPIC_API_KEY
      ? anthropic({ model: "claude-opus-4-8", apiKey: this.env.ANTHROPIC_API_KEY })
      : scripted,
  });
  fetch(req: Request): Promise<Response> {
    return this.#agent.fetch(req);
  }
}

// A Shape-B channel: the module default-exports a `(env) => Channel` factory, so the
// signing secret resolves from the worker env at request time (it doesn't exist at
// module scope on workerd). In a real app this is `agent/channels/crisp.ts`.
const crispCh = (env: Env) =>
  crispChannel({
    signingSecret: env.CRISP_SIGNATURE_SECRET ?? "",
    identifier: env.CRISP_IDENTIFIER ?? "",
    key: env.CRISP_KEY ?? "",
  });

// The Worker routes two inbound edges to the per-session DO, both via June helpers —
// no hand-rolled webhook, no module-global signing-secret setter:
//   • POST /message            → durableAgentSurface (the chat endpoint)
//   • POST /channels/crisp     → durableChannelSurface (verify sig with env secret,
//                                derive the session, run the turn, reply back to Crisp
//                                on ctx.waitUntil). Everything else 404s.
export default {
  fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const chat = durableAgentSurface(() => env.AGENT, { agentName: "ops", chatPath: "/message" });
    const channels = durableChannelSurface(() => env.AGENT, {
      agentName: "ops",
      channels: [crispCh],
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
    });
    return chat(req)
      .then((r) => r ?? channels(req))
      .then((r) => r ?? new Response("POST /message {\"message\",\"session?\"}", { status: 404 }));
  },
};
