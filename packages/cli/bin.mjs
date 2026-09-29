#!/usr/bin/env node
// The `june` bin launcher. It runs on Node ON PURPOSE: the CLI itself
// (src/june.ts) runs on Bun, and without this hop an npm user without Bun
// gets a bare shebang error ("env: bun: No such file or directory") instead
// of a sentence telling them what to install.
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "src/june.ts");
const args = process.argv.slice(2);

const probe = spawnSync("bun", ["--version"], { stdio: "ignore", shell: false });
if (probe.error || probe.status !== 0) {
  console.error(
    "june: the June CLI runs on Bun, which wasn't found on your PATH.\n" +
      "  install it:  curl -fsSL https://bun.sh/install | bash\n" +
      "  (or: brew install oven-sh/bun/bun · https://bun.sh)",
  );
  process.exit(1);
}

// An async child, so this process can relay what is sent to ITS pid: a supervisor's SIGTERM,
// a closed terminal's SIGHUP, a SIGINT sent to the pid alone. Waiting in spawnSync, Node died
// on the signal and left Bun — and whatever Bun runs (`june dev`, an external subcommand) —
// orphaned. Relayed once, while the child runs; it exits on its own terms and we mirror it.
// SIGINT is always caught (so we wait for the child) but relayed only without a terminal:
// Ctrl-C in a terminal already reaches the whole foreground group, and a second SIGINT would
// turn a graceful stop into a forced one.
const child = spawn("bun", [entry, ...args], { stdio: "inherit", shell: false });
const relay = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
process.on("SIGTERM", () => relay("SIGTERM"));
process.on("SIGHUP", () => relay("SIGHUP"));
process.on("SIGINT", () => {
  if (!process.stdin.isTTY) relay("SIGINT");
});
child.on("error", (err) => {
  console.error(`june: could not start bun: ${err.message}`);
  process.exit(1);
});
// A child killed by a signal exits the shell way, 128 + the signal number.
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
});
