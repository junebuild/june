// Step 4: the durable agent surface folded into the shared render pipeline
// (createPipeline — dev + worker). Proves the chat endpoint mounts and runs a
// turn, and that a non-agent path falls through to the router.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ACTION_REGISTRY } from "@junejs/core/agent";
import { resolveAgent } from "@junejs/core/config";
import { route } from "@junejs/core/route";
import type { DocumentConfig } from "@junejs/core/document";
import type { Model, ModelReply } from "@junejs/core/agent-runtime";
import { replyStream } from "@junejs/core/agent-runtime";

import { createPipeline, type MiddlewareHandler, type RouteResolver } from "../src/pipeline";
import { discoverAgent } from "../src/agent-discover";
import { createAgentRuntime, mountAgent } from "../src/agent-native";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-ops");
const docConfig: DocumentConfig = { site: { name: "T" }, speculationRules: null, speculationDelivery: "inline", viewTransitions: false };

let pre = new Map(ACTION_REGISTRY);
beforeEach(() => { pre = new Map(ACTION_REGISTRY); ACTION_REGISTRY.clear(); });
afterEach(() => { ACTION_REGISTRY.clear(); for (const [k, v] of pre) ACTION_REGISTRY.set(k, v); });

function scriptedModel(script: ModelReply[]): Model {
  return (msgs) => replyStream(script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!);
}

// A pipeline with the agent surface mounted from the fixture agent + a scripted
// model (memory backend), and a stub router that records the matched path.
async function makePipeline() {
  let matched: string | undefined;
  const resolve: RouteResolver = async (pathname) => {
    matched = pathname;
    return { def: route({ json: () => ({ ok: true }) }), params: {}, chain: [] };
  };
  const def = await discoverAgent(FIXTURE);
  const model = scriptedModel([
    { text: "Placing your order.", toolCalls: [{ id: "c1", name: "create_order", input: { item: "widget", qty: 3 } }] },
    { text: "Done — order placed.", toolCalls: [] },
  ]);
  const rt = await createAgentRuntime({ [def.name]: { model, tools: def.tools } }, { backend: "memory" });
  const mounted = mountAgent(def, rt, { chatPath: "/message", channels: true });
  const agentSurface: MiddlewareHandler = (req) => mounted.surface(req);
  const pipeline = createPipeline({ docConfig, agent: resolveAgent(undefined), agentSurface, routeList: () => [], resolve });
  return { matchedPath: () => matched, fetch: (r: Request) => pipeline.fetch(r) };
}

describe("durable agent surface in the pipeline", () => {
  test("POST <chat.path> runs a durable turn (never reaches the router)", async () => {
    const p = await makePipeline();
    const res = await p.fetch(new Request("http://x/message", { method: "POST", body: JSON.stringify({ message: "Order 3 widgets", session: "s1" }) }));
    expect(await res.json()).toEqual({ text: "Done — order placed." });
    expect(p.matchedPath()).toBeUndefined();
  });

  test("a non-agent path falls through to the router", async () => {
    const p = await makePipeline();
    const res = await p.fetch(new Request("http://x/thing.json"));
    expect(await res.json()).toEqual({ ok: true });
    expect(p.matchedPath()).toBe("/thing");
  });
});

// ── /mcp identity: cfg.identity feeds the ActionContext the gateway dispatches with ──
describe("/mcp mount identity (cfg.identity)", () => {
  const gatedId = "pipeline_gated_read";
  function mcpCall(id: number) {
    return new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: gatedId, arguments: {} } }),
    });
  }
  async function mcpPipeline(identity?: Parameters<typeof createPipeline>[0]["identity"]) {
    const { defineAction } = await import("@junejs/core/agent");
    defineAction({
      id: gatedId,
      description: "Tenant-scoped read",
      input: { type: "object", properties: {} },
      requiresPrincipal: true,
      run: (_i: unknown, ctx: { user?: { id: string } }) => ({ tenant: ctx.user?.id }),
    });
    const resolve: RouteResolver = async () => null;
    return createPipeline({ docConfig, agent: resolveAgent({ mcp: true }), routeList: () => [], resolve, identity });
  }

  test("with an identity resolver, a requiresPrincipal action runs as that user", async () => {
    const p = await mcpPipeline(() => ({ user: { id: "acme" } }));
    const json = (await (await p.fetch(mcpCall(1))).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(json.result.isError).toBeUndefined();
    expect(JSON.parse(json.result.content[0]!.text)).toEqual({ tenant: "acme" });
  });

  test("without a resolver the same call is rejected (anonymous stays fail-closed)", async () => {
    const p = await mcpPipeline(undefined);
    const json = (await (await p.fetch(mcpCall(2))).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0]!.text).toContain("requires an authenticated principal");
  });
});
