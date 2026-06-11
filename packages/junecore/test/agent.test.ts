import { afterEach, describe, expect, test } from "bun:test";
import {
  ACTION_REGISTRY,
  defineAction,
  invokeAction,
  manifest,
  type JsonSchema,
} from "junecore/agent";

const schema: JsonSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};

afterEach(() => ACTION_REGISTRY.clear());

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
