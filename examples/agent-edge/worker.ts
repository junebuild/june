// A deployable Cloudflare Worker: a durable agent on the edge, one Durable Object
// per session. Uses the real @junejs packages — the same AgentDurableObject +
// durableAgentSurface that June's build will eventually generate for you. Until
// that codegen lands, this hand-written entry is the pattern.
//
//   wrangler dev     → http://localhost:8787   (offline: scripted model, no key)
//   wrangler deploy  → live                     (set ANTHROPIC_API_KEY for real Claude)
//
// Try it:
//   curl -sX POST localhost:8787/message -d '{"message":"order 3 widgets","session":"s1"}'

import { DurableObject } from "cloudflare:workers";
import { AgentDurableObject, durableAgentSurface, type DurableObjectNamespace } from "@junejs/server/agent-durable";
import { anthropic } from "@junejs/core/agent-models";
import { defineAction } from "@junejs/core/agent";
import { actionToTool } from "@junejs/core/agent-config";
import type { Model, ModelReply, Msg } from "@junejs/core/agent-runtime";

type Env = { AGENT: DurableObjectNamespace; ANTHROPIC_API_KEY?: string };

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
const scripted: Model = async (msgs: Msg[]): Promise<ModelReply> => {
  const placed = msgs.some((m) => m.role === "tool" && m.name === "create_order");
  if (!placed) return { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] };
  return { text: "Done — order placed.", toolCalls: [] };
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

// The Worker routes POST /message to the session's DO (durableAgentSurface — the
// same helper createWorker uses). Everything else 404s in this minimal example.
export default {
  fetch(req: Request, env: Env): Promise<Response> {
    const surface = durableAgentSurface(() => env.AGENT, { agentName: "ops", chatPath: "/message" });
    return surface(req).then((r) => r ?? new Response("POST /message {\"message\",\"session?\"}", { status: 404 }));
  },
};
