// External subcommands (#295, docs/rfc-email.md §9.3): `june <verb>` that is not built in
// runs `june-<verb>` — the git / cargo model. Looked up in the app's node_modules/.bin (from
// the working directory up, where a package manager may hoist it), then on PATH. Only the
// binary the user named runs: nothing is scanned or imported in-process, a client versions
// and ships on its own, it works for an operator without the app's repository, and the
// exec boundary survives `june` becoming a native binary.

import { delimiter, dirname, join, resolve } from "node:path";

// First-party external verbs: listed in `june help`, and named in the error when one is
// invoked but not installed. A verb joins when its package is published.
export type ExternalVerb = { package: string; summary: string };
export const FIRST_PARTY: Record<string, ExternalVerb> = {};

// A verb names a binary: lowercase, no separators or dots, so `june ../x` never resolves.
const VERB = /^[a-z][a-z0-9-]*$/;

// The `june-<verb>` binary to run, or null. node_modules/.bin directories nearest first,
// then PATH; Bun.which applies PATHEXT on Windows (npm's .cmd shims, bun's .exe ones).
export function findExternal(verb: string, cwd: string, envPath = process.env.PATH ?? ""): string | null {
  if (!VERB.test(verb)) return null;
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(join(dir, "node_modules", ".bin"));
    if (dirname(dir) === dir) break;
  }
  return Bun.which(`june-${verb}`, { PATH: [...dirs, envPath].join(delimiter) });
}

// ── Windows: running a .cmd/.bat through cmd.exe ──────────────────────────────
// cmd.exe re-parses the command line: `&`, `|`, `%`, `^`, `<`, `>` in an argument would split
// it or run another command (the "BatBadBut" class, CVE-2024-27980) — an argument that
// carries outside text, say an email a coding agent passes along, must reach the command
// literally. This is cross-spawn's escaping (MIT, github.com/moxystudio/node-cross-spawn):
// each argument is quoted with its backslashes and quotes escaped, then every cmd.exe
// metacharacter is ^-escaped — twice for a node_modules/.bin shim, because the shim's `%*`
// hands the arguments to one more parse. The line goes to cmd.exe verbatim (no quoting of
// our own on top).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  // Backslashes before a quote, or at the end, are doubled so they stay literal once quoted.
  let out = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  return doubleEscape ? out.replace(CMD_META, "^$1") : out;
}

// The argv (and whether it is verbatim) to spawn `bin` with `args`.
export function externalCommand(bin: string, args: string[], platform = process.platform): { argv: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { argv: [bin, ...args], verbatim: false };
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(bin);
  const line = [escapeCmdCommand(bin), ...args.map((a) => escapeCmdArgument(a, shim))].join(" ");
  return { argv: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${line}"`], verbatim: true };
}

// Run it with the arguments exactly as typed and the terminal inherited; resolves to its exit
// code. A signal that stops `june` (a supervisor's SIGTERM, a closed terminal's SIGHUP) is
// passed on, so the external command is not left running. SIGINT is always caught — `june`
// waits for the command to finish its own shutdown — but passed on only without a terminal:
// Ctrl-C in a terminal already reaches the command (same foreground group), and a second
// SIGINT would turn its graceful stop into a forced one.
export async function runExternal(bin: string, args: string[]): Promise<number> {
  const { argv, verbatim } = externalCommand(bin, args);
  // env passed explicitly: Bun.spawn otherwise misses variables set on process.env after
  // startup (a caller that sets JUNE_TOKEN in-process before delegating, say).
  const proc = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env }, windowsVerbatimArguments: verbatim });
  const forward = (signal: NodeJS.Signals) => () => proc.kill(signal);
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  const onInt = () => { if (!process.stdin.isTTY) proc.kill("SIGINT"); };
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  process.on("SIGINT", onInt);
  try {
    const code = await proc.exited;
    // Killed by a signal: the shell convention, 128 + the signal number (1 if unrecognized).
    if (proc.signalCode) {
      const n = signalNumber(proc.signalCode);
      return n ? 128 + n : 1;
    }
    return code;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
    process.off("SIGINT", onInt);
  }
}

function signalNumber(signal: string): number {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal] ?? 0;
}

// The first-party external verbs, as `june help` lists them; empty when there are none.
export function firstPartyHelp(firstParty: Record<string, ExternalVerb> = FIRST_PARTY): string {
  const entries = Object.entries(firstParty);
  if (!entries.length) return "";
  const width = Math.max(...entries.map(([v]) => v.length));
  return `\nFirst-party external commands (install the package to use them):\n` +
    entries.map(([verb, e]) => `  ${verb.padEnd(width)}  ${e.summary}  (${e.package})`).join("\n") + "\n";
}

// The error for a verb that is neither built in nor installed.
export function unknownVerbMessage(verb: string, firstParty: Record<string, ExternalVerb> = FIRST_PARTY): string {
  const known = Object.hasOwn(firstParty, verb) ? firstParty[verb] : undefined;
  if (known) {
    return `june ${verb}: ${known.summary} — provided by ${known.package}, which isn't installed.\n` +
      `  install it in this app:  bun add -d ${known.package}\n` +
      `  or run it without installing:  bunx ${known.package}`;
  }
  return `june: unknown command "${verb}" (no built-in command, and no june-${verb} in node_modules/.bin or on PATH)`;
}
