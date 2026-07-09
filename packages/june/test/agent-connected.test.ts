// Connections wired through directory discovery: an agent/connections/*.ts file
// → connectAll → the remote tool joins the agent's tool set, and the agent runs
// a durable turn calling it. A mock global fetch stands in for the MCP server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ACTION_REGISTRY } from "@junejs/core/agent";
import type { Model, ModelReply } from "@junejs/core/agent-runtime";
import { discoverAgent } from "../src/agent-discover";
import { createNativeRuntime } from "../src/agent-native";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-connected");

let preexisting = new Map(ACTION_REGISTRY);
const realFetch = globalThis.fetch;
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const rpc = JSON.parse(init!.body!) as { id: unknown; method: string; params?: { arguments?: { city?: string } } };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    if (rpc.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "weather", version: "1" } });
    if (rpc.method === "tools/list")
      return reply({ tools: [{ name: "get_weather", description: "Current weather", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] });
    if (rpc.method === "tools/call") return reply({ content: [{ type: "text", text: JSON.stringify({ city: rpc.params?.arguments?.city, tempC: 21 }) }] });
    return reply({});
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; ACTION_REGISTRY.clear(); for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a); });

function scriptedModel(script: ModelReply[]): Model {
  return async (msgs) => script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!;
}

describe("discoverAgent — connections", () => {
  test("a connection's remote tool joins the agent's tools and is reported", async () => {
    const agent = await discoverAgent(FIXTURE);
    expect(agent.tools.map((t) => t.spec.name)).toContain("weather__get_weather");
    expect(agent.connections).toEqual([
      { name: "weather", kind: "mcp", url: "http://mock/mcp", tools: ["weather__get_weather"] },
    ]);
  });

  test("the agent runs a durable turn that calls the remote connection tool", async () => {
    const agent = await discoverAgent(FIXTURE);
    const model = scriptedModel([
      { text: "Checking the weather.", toolCalls: [{ id: "c1", name: "weather__get_weather", input: { city: "Taipei" } }] },
      { text: "It's 21°C in Taipei.", toolCalls: [] },
    ]);
    const rt = await createNativeRuntime({ [agent.name]: { model, tools: agent.tools } });
    const answer = await rt.session(agent.name, "s1").turn({ turnId: "t1", userText: "weather in Taipei?" });

    expect(answer).toBe("It's 21°C in Taipei.");
    const turn = rt.session(agent.name, "s1").transcript()[0]!;
    expect(turn.steps[0]).toEqual({ name: "weather__get_weather", done: true, result: { city: "Taipei", tempC: 21 } });
  });
});
