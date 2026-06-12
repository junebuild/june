import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACTION_REGISTRY,
  defineAction,
  invokeAction,
  manifest,
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

describe("ActionContext (run(input, ctx) — the principal + resources)", () => {
  test("invokeAction threads the principal and resources to run()", async () => {
    let seen: ActionContext | undefined;
    const fakeDb = {} as ActionContext["db"];
    defineAction({
      id: "whoami",
      description: "Who am I",
      input: { type: "object", properties: {} },
      run: (_input, ctx) => {
        seen = ctx;
        return { userId: ctx.user?.id ?? null };
      },
    });
    const result = await invokeAction("whoami", {}, { user: { id: "u1" }, db: fakeDb });
    expect(result).toEqual({ userId: "u1" });
    expect(seen?.db).toBe(fakeDb);
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

describe("manifest.resource()", () => {
  test("produces a capability manifest with POST/x-june-action invocation", () => {
    const createUser = defineAction({
      id: "createUser",
      description: "Create a user",
      input: schema,
      run: () => ({}),
    });
    const m = manifest.resource("users", [{ id: 1 }]).actions([createUser]).toManifest();
    expect(m.resource).toBe("users");
    expect(m.data).toEqual([{ id: 1 }]);
    expect(m.actions[0]).toEqual({
      id: "createUser",
      description: "Create a user",
      input: schema,
      invoke: { method: "POST", header: "x-june-action", action: "createUser" },
    });
  });
});
