// defineAgent + the defineAction→Tool bridge. The point of the bridge is the
// thesis "an agent's tools ARE your server actions" — so this asserts a real
// defineAction becomes a runnable Tool with sync/async semantics preserved (the
// engine keys exactly-once vs at-least-once off that).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { actionToTool, buildSystemPrompt, defineAgent, readSkillTool, type Channel, type Skill } from "@junejs/core/agent-config";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";

// defineAction self-registers globally; isolate the registry per test.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => { preexisting = new Map(ACTION_REGISTRY); ACTION_REGISTRY.clear(); });
afterEach(() => { ACTION_REGISTRY.clear(); for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a); });

const orderSchema = {
  type: "object",
  properties: { item: { type: "string" }, qty: { type: "number" } },
  required: ["item"],
} as const;

describe("actionToTool", () => {
  test("bridges a sync defineAction into a sync (exactly-once) Tool", async () => {
    const createOrder = defineAction({
      id: "create_order",
      description: "Place an order",
      input: orderSchema,
      run: (input) => ({ orderId: 1, item: input.item, qty: input.qty ?? 1 }),
    });
    const tool = actionToTool(createOrder);

    expect(tool.spec).toEqual({ name: "create_order", description: "Place an order", input: orderSchema });
    expect(tool.run.constructor.name).toBe("Function"); // sync ⇒ engine runs it in-tx (exactly-once)
    expect(await tool.run({ item: "widget", qty: 3 }, {} as never)).toEqual({ orderId: 1, item: "widget", qty: 3 });
  });

  test("bridges an async defineAction into an async (at-least-once) Tool", async () => {
    const lookup = defineAction({
      id: "lookup_inventory",
      description: "Look up stock",
      input: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } as const,
      run: async (input) => ({ item: input.item, inStock: 42 }),
    });
    const tool = actionToTool(lookup);

    expect(tool.run.constructor.name).toBe("AsyncFunction"); // async ⇒ engine treats it remote (at-least-once)
    expect(await tool.run({ item: "widget" }, {} as never)).toEqual({ item: "widget", inStock: 42 });
  });
});

describe("defineAgent", () => {
  test("assembles config + adapted tools; adds read_skill when skills exist", () => {
    const createOrder = defineAction({
      id: "create_order", description: "Place an order", input: orderSchema,
      run: (input) => ({ item: input.item }),
    });
    const skills: Skill[] = [{ name: "bulk_reorder", description: "Reorder many items", body: "1. ...\n2. ..." }];

    const agent = defineAgent({
      name: "ops",
      model: "claude-opus-4-8",
      description: "Ops assistant",
      instructions: "You place orders.",
      tools: [createOrder],
      skills,
    });

    expect(agent.name).toBe("ops");
    expect(agent.model).toBe("claude-opus-4-8");
    expect(agent.instructions).toBe("You place orders.");
    expect(agent.tools.map((t) => t.spec.name)).toEqual(["create_order", "read_skill"]);
    expect(agent.skills).toEqual(skills);
  });

  test("merges a channel's capability tools into agent.tools (before read_skill)", () => {
    const readThread: Tool = {
      spec: { name: "slack_read_thread", description: "Read a thread's replies", input: { type: "object", properties: {} } },
      run: () => ({ messages: [] }),
    };
    const slackish: Channel = { name: "slack", path: "/channels/slack", tools: () => [readThread] };
    const skills: Skill[] = [{ name: "triage", description: "Triage a thread", body: "..." }];

    const agent = defineAgent({ name: "ops", tools: [], channels: [slackish], skills });

    // channel tool is present, and read_skill stays last (ordering contract)
    expect(agent.tools.map((t) => t.spec.name)).toEqual(["slack_read_thread", "read_skill"]);
    expect(agent.channels).toEqual([slackish]);
  });

  test("a channel without tools contributes none", () => {
    const bare: Channel = { name: "http" };
    const agent = defineAgent({ name: "ops", tools: [], channels: [bare] });
    expect(agent.tools).toHaveLength(0);
  });

  test("throws on a duplicate tool name (channel tool shadowing an app tool)", () => {
    const dup: Tool = { spec: { name: "create_order", description: "dupe", input: { type: "object", properties: {} } }, run: () => ({}) };
    const createOrder = defineAction({
      id: "create_order", description: "Place an order", input: orderSchema, run: (input) => ({ item: input.item }),
    });
    const clash: Channel = { name: "x", tools: () => [dup] };
    expect(() => defineAgent({ name: "ops", tools: [createOrder], channels: [clash] })).toThrow(/duplicate tool name "create_order"/);
  });

  test("no skills ⇒ no read_skill tool", () => {
    const agent = defineAgent({ name: "bare", tools: [] });
    expect(agent.tools).toHaveLength(0);
    expect(agent.instructions).toBe("");
  });

  test("read_skill returns a known skill's body and errors on an unknown one", async () => {
    const tool = readSkillTool([{ name: "bulk_reorder", description: "d", body: "the steps" }]);
    expect(await tool.run({ name: "bulk_reorder" }, {} as never)).toEqual({ name: "bulk_reorder", body: "the steps" });
    expect(await tool.run({ name: "nope" }, {} as never)).toEqual({ error: "unknown skill: nope" });
  });
});

describe("buildSystemPrompt", () => {
  test("appends a one-line skill index to the instructions", () => {
    const agent = defineAgent({
      name: "ops",
      instructions: "You place orders.",
      skills: [{ name: "bulk_reorder", description: "Reorder many items", body: "..." }],
    });
    const prompt = buildSystemPrompt(agent);
    expect(prompt).toContain("You place orders.");
    expect(prompt).toContain("## Available skills (call read_skill to load one)");
    expect(prompt).toContain("- bulk_reorder: Reorder many items");
  });
});

// ── actionToTool identity bridging: ToolContext.principal → ActionContext.user ──
describe("actionToTool identity", () => {
  test("threads the turn's principal into the action's ctx.user (and nothing when anonymous)", async () => {
    const seen: unknown[] = [];
    const whoami = defineAction({
      id: "whoami",
      description: "Echo the caller",
      input: { type: "object", properties: {} },
      run: (_i, ctx) => { seen.push(ctx); return ctx.user?.id ?? "anonymous"; },
    });
    const tool = actionToTool(whoami);
    // identified turn: the SAME identity field a UI POST or /mcp call carries
    expect(await tool.run({}, { principal: { id: "owner@school.tw" } } as unknown as ToolContext)).toBe("owner@school.tw");
    expect(seen[0]).toEqual({ user: { id: "owner@school.tw" } });
    // anonymous turn: empty ActionContext, exactly like an unauthenticated dispatch
    expect(await tool.run({}, {} as ToolContext)).toBe("anonymous");
    expect(seen[1]).toEqual({});
  });

  test("copies requiresPrincipal onto the bridged Tool (turn-engine gating)", () => {
    const gated = defineAction({
      id: "tenant_read",
      description: "Tenant-scoped read",
      input: { type: "object", properties: {} },
      requiresPrincipal: true,
      run: () => "data",
    });
    expect(actionToTool(gated).requiresPrincipal).toBe(true);
    expect(actionToTool({ ...gated, id: "open_read", requiresPrincipal: undefined }).requiresPrincipal).toBeUndefined();
  });
});
