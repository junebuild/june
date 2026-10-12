// Files as turn output on the in-process hosts (docs/rfc-agent-files.md): the runtime
// installs its FileStore on every session it builds, and mountAgent hands the same store to
// the channels, so a file a tool stored is the file a channel delivers. The engine side is
// covered in @junejs/core's agent-runtime test.

import { describe, expect, test } from "bun:test";

import { memoryFileStore } from "@junejs/core/agent-files";
import { defineAgent } from "@junejs/core/agent-config";
import { replyStream, type Model, type Tool, type TurnEvent } from "@junejs/core/agent-runtime";
import { createAgentRuntime, mountAgent, toAgentDef } from "../src/agent-native";

const callRender: Model = (msgs) =>
  replyStream(
    msgs.some((m) => m.role === "tool")
      ? { text: "Attached.", toolCalls: [] }
      : { text: "", toolCalls: [{ id: "c1", name: "render", input: {} }] },
  );

const render: Tool = {
  spec: { name: "render", description: "render a report", input: { type: "object" } },
  run: async (_input: unknown, ctx) => ctx.files.put(new TextEncoder().encode("%PDF-1.7"), { name: "r.pdf", mediaType: "application/pdf" }),
};

const agent = defineAgent({ name: "ops", tools: [render] });

describe("agent files on the in-process runtimes", () => {
  for (const backend of ["native", "memory"] as const) {
    test(`${backend}: a tool's file is readable through the channel context`, async () => {
      const files = memoryFileStore();
      const rt = await createAgentRuntime({ ops: toAgentDef(agent, callRender) }, { backend, files });
      try {
        const { ctx } = mountAgent(agent, rt);
        expect(ctx.files).toBe(files);
        const events: TurnEvent[] = [];
        for await (const e of ctx.runStream!("report", { session: "s1" })) events.push(e);
        const attached = events.find((e) => e.type === "file.attached") as Extract<TurnEvent, { type: "file.attached" }>;
        expect(attached.file).toMatchObject({ name: "r.pdf", mediaType: "application/pdf", size: 8 });
        expect(new TextDecoder().decode((await ctx.files!.get(attached.file.id))!)).toBe("%PDF-1.7");
      } finally {
        await rt.close();
      }
    });
  }

  test("without a store the turn fails and says what to configure", async () => {
    const rt = await createAgentRuntime({ ops: toAgentDef(agent, callRender) }, { backend: "memory" });
    try {
      const { ctx } = mountAgent(agent, rt);
      expect(ctx.files).toBeUndefined();
      const events: TurnEvent[] = [];
      for await (const e of ctx.runStream!("report", { session: "s1" })) events.push(e);
      expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: { message: expect.stringContaining("resources.blob") } });
    } finally {
      await rt.close();
    }
  });

  test("mountAgent's own files option wins over the runtime's", async () => {
    const rt = await createAgentRuntime({ ops: toAgentDef(agent, callRender) }, { backend: "memory", files: memoryFileStore() });
    try {
      const mine = memoryFileStore();
      expect(mountAgent(agent, rt, { files: mine }).ctx.files).toBe(mine);
    } finally {
      await rt.close();
    }
  });
});
