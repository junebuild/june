import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { coercePort, parse, run } from "../src/cli";

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

describe("coercePort()", () => {
  test("--port > PORT > default, junk falls back", () => {
    expect(coercePort("4100", 3000)).toBe(4100); // valid string
    expect(coercePort(undefined, 3000)).toBe(3000); // no PORT env
    expect(coercePort("", 3000)).toBe(3000); // PORT=
    expect(coercePort("abc", 3000)).toBe(3000); // PORT=abc
    expect(coercePort(true, 3000)).toBe(3000); // `--port` with no value → not port 1
    expect(coercePort("0", 3000)).toBe(3000); // out of range
    expect(coercePort("70000", 3000)).toBe(3000); // out of range
  });
  test("composes to the --port > PORT > 3000 precedence", () => {
    expect(coercePort("5001", coercePort("4100", 3000))).toBe(5001); // flag wins
    expect(coercePort(undefined, coercePort("4100", 3000))).toBe(4100); // env wins
    expect(coercePort(undefined, coercePort(undefined, 3000))).toBe(3000); // default
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

describe("june db", () => {
  test("an unknown db subcommand lists the valid ones", async () => {
    const code = await run(["db", "frobnicate", FIXTURE]);
    expect(code).toBe(1);
    expect(text()).toContain("unknown subcommand");
    expect(text()).toContain("june db types");
  });

  test("db types without a db resource fails with a sentence", async () => {
    // The basic fixture declares no `db` resource → the guard fires (returns 1),
    // not an ENOENT. (Generation itself is covered e2e in @junejs/juno.)
    const code = await run(["db", "types", FIXTURE]);
    expect(code).toBe(1);
    expect(text()).toContain("no `db` resource");
  });
});

describe("june dev argument validation", () => {
  test("a digits positional (npm run dev -p 3001 → 'dev 3001') hints at --port", async () => {
    const code = await run(["dev", "3001"]);
    expect(code).toBe(1);
    expect(text()).toContain("doesn't look like a June app");
    expect(text()).toContain("--port 3001");
  });

  test("a missing app dir fails with a sentence, not an ENOENT", async () => {
    expect(await run(["dev", "/tmp/definitely-not-a-june-app"])).toBe(1);
    expect(text()).toContain("no app/ directory");
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
  test("--help after a verb prints help without running the command", async () => {
    // Would otherwise start the dev server (and hang) — the intercept returns first.
    expect(await run(["dev", "--help"])).toBe(0);
    expect(text()).toContain("Usage: june <command>");
  });
  test("build --help prints help, doesn't build", async () => {
    expect(await run(["build", "--help"])).toBe(0);
    expect(text()).toContain("Commands:");
  });
});
