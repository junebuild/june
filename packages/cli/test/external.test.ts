// External subcommands (#295): `june <verb>` that is not built in runs `june-<verb>` from
// node_modules/.bin (walking up) or PATH, with the arguments as typed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli";
import { externalCommand, findExternal, firstPartyHelp, runExternal, unknownVerbMessage } from "../src/external";

const isWin = process.platform === "win32";

let root: string;
let out: string[];
const origLog = console.log;
const origErr = console.error;
const origCwd = process.cwd();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "june-ext-"));
  out = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => out.push(a.join(" "));
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.chdir(origCwd);
  delete process.env.JUNE_EXT_OUT;
  rmSync(root, { recursive: true, force: true });
});

// A `june-<verb>` shell script that records its arguments to $JUNE_EXT_OUT and exits `code`.
function bin(dir: string, verb: string, body = 'printf "%s|" "$@" > "$JUNE_EXT_OUT"; exit 7'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `june-${verb}`);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(isWin)("external subcommands (#295)", () => {
  test("findExternal walks up to a parent's node_modules/.bin", () => {
    const file = bin(join(root, "node_modules", ".bin"), "hello");
    const deep = join(root, "packages", "app");
    mkdirSync(deep, { recursive: true });
    expect(findExternal("hello", deep, "")).toBe(file);
  });

  test("the nearest node_modules/.bin wins over a parent's, and over PATH", () => {
    const onPath = bin(join(root, "on-path"), "hello");
    bin(join(root, "node_modules", ".bin"), "hello");
    const near = bin(join(root, "app", "node_modules", ".bin"), "hello");
    expect(findExternal("hello", join(root, "app"), join(root, "on-path"))).toBe(near);
    expect(findExternal("hello", join(root, "elsewhere"), join(root, "on-path"))).toBe(join(root, "node_modules", ".bin", "june-hello"));
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(findExternal("hello", join(root, "elsewhere"), join(root, "on-path"))).toBe(onPath);
  });

  test("a verb that is not a plain name never resolves", () => {
    bin(join(root, "node_modules", ".bin"), "hello");
    for (const verb of ["../hello", "Hello", "hel/lo", "-hello", "", "hello.sh"]) {
      expect(findExternal(verb, root, "")).toBeNull();
    }
  });

  test("june <verb> runs it with the arguments exactly as typed and returns its exit code", async () => {
    bin(join(root, "node_modules", ".bin"), "hello");
    process.env.JUNE_EXT_OUT = join(root, "args.txt");
    process.chdir(root);
    // --json and the space stay intact: june's own parser never touches them
    expect(await run(["hello", "pending", "--json", "two words"])).toBe(7);
    expect(readFileSync(join(root, "args.txt"), "utf8")).toBe("pending|--json|two words|");
  });

  test("a built-in command is never shadowed by a june-<verb> binary", async () => {
    bin(join(root, "node_modules", ".bin"), "help");
    process.env.JUNE_EXT_OUT = join(root, "args.txt");
    process.chdir(root);
    expect(await run(["help"])).toBe(0);
    expect(existsSync(join(root, "args.txt"))).toBe(false);
    expect(out.join("\n")).toContain("june — the agent-native React framework");
  });

  test("an unknown verb says where it looked, and exits 1", async () => {
    process.chdir(root);
    expect(await run(["nope"])).toBe(1);
    expect(out.join("\n")).toContain('unknown command "nope" (no built-in command, and no june-nope in node_modules/.bin or on PATH)');
  });

  // Through the published entry point: node bin.mjs → bun src/june.ts → the external command.
  // A signal sent to the june pid alone must reach the external command, not orphan it.
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
    test.skipIf(!Bun.which("node"))(`${signal} to the real june bin stops the external command and exits ${code}`, async () => {
      const pidFile = join(root, "child.pid");
      bin(join(root, "node_modules", ".bin"), "sleepy", `echo $$ > "${pidFile}"\nexec sleep 30`);
      const june = Bun.spawn(["node", join(import.meta.dir, "..", "bin.mjs"), "sleepy"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(25);
      const child = Number(readFileSync(pidFile, "utf8"));
      june.kill(signal);
      expect(await june.exited).toBe(code);
      await Bun.sleep(100);
      const alive = (() => { try { process.kill(child, 0); return true; } catch { return false; } })();
      if (alive) process.kill(child, "SIGKILL");
      expect(alive).toBe(false);
    });
  }

  // Ctrl-C in a terminal reaches the whole foreground group; june must not add a second SIGINT
  // (a graceful stop would turn forced), and must wait for the command's own shutdown.
  test.skipIf(!Bun.which("node"))("Ctrl-C in a terminal reaches the command exactly once, and june waits for it", async () => {
    const countFile = join(root, "count.txt");
    bin(join(root, "node_modules", ".bin"), "counter", [
      `n=0; trap 'n=$((n+1)); echo $n > "${countFile}"; stop=1' INT`,
      `echo ready > "${countFile}"`,
      `i=0; while [ $i -lt 100 ]; do if [ -n "$stop" ]; then sleep 0.5; exit 0; fi; sleep 0.1; i=$((i+1)); done`,
    ].join("\n"));
    const read = () => (existsSync(countFile) ? readFileSync(countFile, "utf8").trim() : "");
    const june = Bun.spawn(["node", join(import.meta.dir, "..", "bin.mjs"), "counter"], { cwd: root, terminal: { cols: 80, rows: 24, data() {} } });
    for (let i = 0; i < 200 && read() !== "ready"; i++) await Bun.sleep(25);
    june.terminal!.write("\x03");
    expect(await june.exited).toBe(0); // the command's graceful exit, mirrored
    expect(read()).toBe("1");
  });

  test("an external command killed by a signal exits 128 + the signal", async () => {
    const file = bin(join(root, "node_modules", ".bin"), "die", "kill -TERM $$");
    expect(await runExternal(file, [])).toBe(143);
  });
});

// Pinned from cross-spawn's algorithm, and verified end to end on Windows 11 (2026-09-28):
// 23 hostile arguments (& | % ! ^ quotes, backslashes, a `& echo pwned >` payload) reached
// both an npm .cmd shim and a bun .exe shim literally, with nothing injected — where
// `cmd.exe /d /c <shim> <args>` split "a&b" and ran "b" as a command.
describe("the Windows command line for .cmd/.bat (#295)", () => {
  const cmd = process.env.ComSpec ?? "cmd.exe";

  test("a node_modules/.bin .cmd shim: quoted, and every cmd.exe metacharacter escaped twice", () => {
    expect(externalCommand("C:\\app\\node_modules\\.bin\\june-x.cmd", ["a&b", "100%", "two words"], "win32")).toEqual({
      argv: [cmd, "/d", "/s", "/c", '"C:\\app\\node_modules\\.bin\\june-x.cmd ^^^"a^^^&b^^^" ^^^"100^^^%^^^" ^^^"two^^^ words^^^""'],
      verbatim: true,
    });
  });

  test("a standalone .bat: escaped once", () => {
    expect(externalCommand("C:\\tools\\june-x.bat", ["a&b"], "win32").argv.at(-1)).toBe('"C:\\tools\\june-x.bat ^"a^&b^""');
  });

  test("an .exe, or any other platform: the argv as given", () => {
    expect(externalCommand("C:\\app\\node_modules\\.bin\\june-x.exe", ["a&b"], "win32")).toEqual({ argv: ["C:\\app\\node_modules\\.bin\\june-x.exe", "a&b"], verbatim: false });
    expect(externalCommand("/app/node_modules/.bin/june-x", ["a&b"], "linux")).toEqual({ argv: ["/app/node_modules/.bin/june-x", "a&b"], verbatim: false });
  });
});

describe("first-party external verbs (#295)", () => {
  const table = { inbox: { package: "@junejs/inbox", summary: "supervise an agent's inbox" } };

  test("a first-party verb that isn't installed gets an install hint", () => {
    const msg = unknownVerbMessage("inbox", table);
    expect(msg).toContain("provided by @junejs/inbox, which isn't installed");
    expect(msg).toContain("bun add -d @junejs/inbox");
    expect(msg).toContain("bunx @junejs/inbox");
  });

  test("an inherited property is not a first-party verb", () => {
    expect(unknownVerbMessage("constructor", table)).toContain('unknown command "constructor"');
  });

  test("june help lists first-party verbs, and nothing when there are none", () => {
    expect(firstPartyHelp(table)).toContain("inbox  supervise an agent's inbox  (@junejs/inbox)");
    expect(firstPartyHelp({})).toBe("");
  });
});
