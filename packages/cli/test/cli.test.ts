import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { parse, run } from "../src/cli";

const FIXTURE = fileURLToPath(new URL("../../../examples/basic", import.meta.url));

// Capture console output so we can assert on what the CLI prints.
let out: string[];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  out = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => out.push(a.join(" "));
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});
const text = () => out.join("\n");

describe("parse()", () => {
  test("verb + positional dir + flags (boolean and valued)", () => {
    expect(parse(["build", "./app", "--out", "dist", "--dry-run"])).toEqual({
      verb: "build",
      positional: ["./app"],
      flags: { out: "dist", "dry-run": true },
    });
  });
  test("empty argv → empty verb", () => {
    expect(parse([])).toEqual({ verb: "", positional: [], flags: {} });
  });
});

describe("june info", () => {
  test("lists routes and the agent surface (tools from warmup)", async () => {
    const code = await run(["info", FIXTURE]);
    expect(code).toBe(0);
    const t = text();
    expect(t).toContain("June app: June Basic");
    expect(t).toContain("/users");
    expect(t).toContain("/posts/[slug]");
    expect(t).toContain("/mcp");
    expect(t).toContain("createUser"); // the fixture's defineAction, registered on warmup
  });
});

describe("june gen", () => {
  test("freezes the content collection", async () => {
    const code = await run(["gen", FIXTURE]);
    expect(code).toBe(0);
    expect(text()).toContain("posts");
  });
});

describe("help / unknown", () => {
  test("help returns 0 and prints usage", async () => {
    expect(await run(["help"])).toBe(0);
    expect(text()).toContain("Usage: june <command>");
  });
  test("no command prints help, returns 0", async () => {
    expect(await run([])).toBe(0);
    expect(text()).toContain("Commands:");
  });
  test("unknown command returns 1", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(text()).toContain('unknown command "frobnicate"');
  });
});
