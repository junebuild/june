// Directory discovery, end to end: an agent/ directory → an AgentDefinition →
// a durable turn that calls a discovered tool. This closes the loop the PoC
// proved (one directory → durable agent), now on the monorepo packages.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ACTION_REGISTRY } from "@junejs/core/agent";
import type { Model, ModelReply } from "@junejs/core/agent-runtime";
import { discoverAgent } from "../src/agent-discover";
import { createNativeRuntime, mountAgent } from "../src/agent-native";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-ops");

const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Discovering a tool imports a defineAction that self-registers globally; isolate.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => { preexisting = new Map(ACTION_REGISTRY); ACTION_REGISTRY.clear(); });
afterEach(() => { ACTION_REGISTRY.clear(); for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a); });

function scriptedModel(script: ModelReply[]): Model {
  return async (msgs) => script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!;
}

describe("discoverAgent", () => {
  test("assembles an agent from its directory", async () => {
    const agent = await discoverAgent(FIXTURE);

    expect(agent.name).toBe("ops");
    expect(agent.model).toBe("claude-opus-4-8");
    expect(agent.description).toContain("operations assistant");
    expect(agent.instructions).toContain("operations assistant");
    // discovered tool + the synthesized read_skill (skills/ is non-empty)
    expect(agent.tools.map((t) => t.spec.name).sort()).toEqual(["create_order", "read_skill"]);
    expect(agent.skills).toEqual([
      { name: "bulk_reorder", description: "Reorder many items at once from a supplier list, checking stock first.", body: expect.stringContaining("Read the supplier list") },
    ]);
    // channels discovered too (a plain http channel + a factory-built slack one)
    expect(agent.channels.map((c) => c.name).sort()).toEqual(["http", "slack"]);
  });

  test("resolves a Shape-B (env)=>Channel factory channel from process.env (native)", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-secret-xyz";
    try {
      const agent = await discoverAgent(FIXTURE);
      const slack = agent.channels.find((c) => c.name === "slack")!;
      expect(slack.webhook).toBeInstanceOf(Function); // resolved to a Channel, not left as the raw factory

      // A request signed with the ENV secret verifies — proving the factory read
      // process.env at discovery, not the fallback literal. (valid() runs before the
      // url_verification branch, so a 200 + challenge echo ⇒ the signature passed.)
      const body = JSON.stringify({ type: "url_verification", challenge: "ok" });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = "v0=" + (await hmacHex("env-secret-xyz", `v0:${ts}:${body}`));
      const req = new Request("http://x/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
      const res = await slack.webhook!(req, { agent, run: async () => "" });
      expect(await res.json()).toEqual({ challenge: "ok" });
    } finally {
      delete process.env.SLACK_SIGNING_SECRET;
    }
  });

  test("mountAgent serves a discovered channel end-to-end (POST /message → durable turn)", async () => {
    const agent = await discoverAgent(FIXTURE);
    const model = scriptedModel([
      { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
      { text: "Done — order placed.", toolCalls: [] },
    ]);
    const rt = await createNativeRuntime({ [agent.name]: { model, tools: agent.tools } });
    const { fetch } = mountAgent(agent, rt);

    const res = await fetch(new Request("http://x/message", { method: "POST", body: JSON.stringify({ message: "Order 3 widgets", session: "s1" }) }));
    expect(await res!.json()).toEqual({ text: "Done — order placed." });
  });

  test("the discovered agent runs a durable turn calling its discovered tool", async () => {
    const agent = await discoverAgent(FIXTURE);
    const model = scriptedModel([
      { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
      { text: "Done — order placed.", toolCalls: [] },
    ]);

    const rt = await createNativeRuntime({ [agent.name]: { model, tools: agent.tools } });
    const answer = await rt.session(agent.name, "s1").turn({ turnId: "t1", userText: "Order 3 widgets" });

    expect(answer).toBe("Done — order placed.");
    const turn = rt.session(agent.name, "s1").transcript()[0]!;
    expect(turn.steps).toEqual([{ name: "create_order", done: true, result: { orderId: 1, item: "widget", qty: 3 } }]);
  });
});
