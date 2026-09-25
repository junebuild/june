// #173: one definition for the engine and the channels. toAgentDef derives the runtime
// entry from the AgentDefinition mountAgent mounts; both in-process backends apply it the
// same way; mountAgent says so when a hand-built runtime entry has drifted.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { defineAgent } from "@junejs/core/agent-config";
import type { InboundEvent, Model, Tool, ToolSpec } from "@junejs/core/agent-runtime";
import { replyStream } from "@junejs/core/agent-runtime";
import { createAgentRuntime, mountAgent, toAgentDef, type AgentBackend } from "../src/agent-native";

const tool = (name: string): Tool => ({ spec: { name, description: "", input: { type: "object" } }, run: () => ({}) });

// Records what each model call was given: the system prompt and the tool names.
function recordingModel() {
  const seen: { system?: string; tools: string[] }[] = [];
  const model: Model = (_msgs, specs: ToolSpec[], o) => {
    seen.push({ system: o?.system, tools: specs.map((s) => s.name) });
    return replyStream({ text: "ok", toolCalls: [] });
  };
  return { model, seen };
}

const slackEvent: InboundEvent = { source: "slack", kind: "app_mention", channelId: "C1", ts: "1.1" };

const warn = spyOn(console, "warn");
afterEach(() => warn.mockClear());

describe("toAgentDef (#173)", () => {
  for (const backend of ["native", "memory"] as AgentBackend[]) {
    test(`${backend}: instructions and per-surface policies from the definition reach the model`, async () => {
      const agent = defineAgent({
        name: "ops",
        instructions: "Base prompt.",
        tools: [tool("search"), tool("delete_all")],
        channelInstructions: { slack: { overlay: "Be brief in Slack.", denyTools: ["delete_all"] } },
      });
      const { model, seen } = recordingModel();
      const rt = await createAgentRuntime({ ops: toAgentDef(agent, model) }, { backend });
      const { ctx } = mountAgent(agent, rt);

      await ctx.run("hi", { session: "api" });
      await ctx.run("hi", { session: "slack", event: slackEvent });

      expect(seen[0]).toEqual({ system: "Base prompt.", tools: ["search", "delete_all"] });
      expect(seen[1]!.system).toContain("Base prompt.");
      expect(seen[1]!.system).toContain("Be brief in Slack.");
      expect(seen[1]!.tools).toEqual(["search"]); // denied mechanically on the slack surface
      // (defineAgent's own "no mounted slack channel" notice is expected here — no drift one)
      expect(warn.mock.calls.some((c) => String(c[0]).includes("mountAgent"))).toBe(false);
    });
  }

  test("the system prompt carries the skill index, like every other assembly path", () => {
    const agent = defineAgent({ name: "ops", instructions: "Base.", skills: [{ name: "refunds", description: "How refunds work", body: "…" }] });
    const def = toAgentDef(agent, recordingModel().model);
    expect(def.instructions).toContain("Base.");
    expect(def.instructions).toContain("refunds");
    expect(def.tools.map((t) => t.spec.name)).toContain("read_skill");
  });

  test("mountAgent warns once when a hand-built runtime entry's tools drift from the definition", async () => {
    const agent = defineAgent({ name: "ops", instructions: "", tools: [tool("search"), tool("lookup")] });
    const rt = await createAgentRuntime({ ops: { model: recordingModel().model, tools: [tool("search"), tool("stale")] } });
    mountAgent(agent, rt);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain("missing from the runtime: lookup");
    expect(msg).toContain("only in the runtime: stale");
    expect(msg).toContain("toAgentDef");
  });
});
