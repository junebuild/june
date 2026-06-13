import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACTION_REGISTRY,
  defineAction,
  invokeAction,
  type JsonSchema,
} from "@junejs/core/agent";
import type { ActionContext } from "@junejs/core/context";

const schema: JsonSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};

// Empty registry per test, restored after — see discovery.test.ts: a cleared
// registry cannot be repopulated by re-import (module cache), which breaks
// later test files.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  ACTION_REGISTRY.clear();
  for (const [id, action] of preexisting) ACTION_REGISTRY.set(id, action);
});

describe("defineAction()", () => {
  test("registers into the unified registry and returns the definition", () => {
    const action = defineAction({
      id: "createUser",
      description: "Create a user",
      input: schema,
      run: (input: { name: string }) => ({ created: input.name }),
    });
    expect(ACTION_REGISTRY.get("createUser")).toBe(action);
  });
});

describe("ActionContext (run(input, ctx) — identity; resources are ambient)", () => {
  test("invokeAction threads the principal to run()", async () => {
    let seen: ActionContext | undefined;
    defineAction({
      id: "whoami",
      description: "Who am I",
      input: { type: "object", properties: {} },
      run: (_input, ctx) => {
        seen = ctx;
        return { userId: ctx.user?.id ?? null };
      },
    });
    const result = await invokeAction("whoami", {}, { user: { id: "u1" } });
    expect(result).toEqual({ userId: "u1" });
    expect(seen?.user?.id).toBe("u1");
    // ctx is identity only — db/kv/blob are NOT on it (they're ambient).
    expect("db" in (seen ?? {})).toBe(false);
  });

  test("an action that ignores ctx (one-param run) still works", async () => {
    defineAction({
      id: "ping",
      description: "Ping",
      input: { type: "object", properties: {} },
      run: () => ({ ok: true }),
    });
    expect(await invokeAction("ping", {})).toEqual({ ok: true });
  });
});

describe("invokeAction()", () => {
  test("dispatches by id and returns the run() result", async () => {
    defineAction({
      id: "echo",
      description: "Echo",
      input: schema,
      run: (input: { name: string }) => ({ echoed: input.name }),
    });
    expect(await invokeAction("echo", { name: "Ada" })).toEqual({ echoed: "Ada" });
  });

  test("throws on an unknown action id", () => {
    expect(invokeAction("missing", {})).rejects.toThrow("Unknown action: missing");
  });
});
