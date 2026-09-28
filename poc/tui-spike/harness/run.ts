// Drives the spike under a real pseudo-terminal (Bun.Terminal: openpty on
// POSIX, ConPTY on Windows) and replays its output into a headless xterm, so
// the checks look at what a user would see. It also answers the terminal
// queries the TUI sends at startup, like a real emulator.
//
//   bun harness/run.ts [--bin dist/tui-spike | --cmd '<json argv>'] [--only session,crash] [--out results.json]
//
// Exit code: the number of failed checks.

import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Report } from "../src/metrics";

const root = resolve(import.meta.dir, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
// --bin <path> for a single executable (Windows PowerShell strips the quotes
// out of a JSON --cmd), --cmd '<json argv>' for anything longer.
const cmd: string[] = args.has("bin")
  ? [resolve(args.get("bin")!)]
  : args.has("cmd")
    ? JSON.parse(args.get("cmd")!)
    : [process.execPath, join(root, "src/main.tsx")];
const only = args.get("only")?.split(",");
const isWin = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "tui-spike-harness-"));

type Check = { scenario: string; name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const notes: Record<string, unknown> = {};
function check(scenario: string, name: string, ok: boolean, detail?: unknown) {
  checks.push({ scenario, name, ok, detail: detail === undefined ? undefined : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${scenario} · ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launch(argv: string[], cols: number, rows: number, env: Record<string, string> = {}) {
  // Two emulators on the same bytes: Unicode 11 widths (VS Code, Windows
  // Terminal, current emulators) is the one we assert on; Unicode 6 widths
  // stands in for legacy wcwidth tables and is only reported.
  const xterm = new Terminal({ cols, rows, allowProposedApi: true });
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = "11";
  const legacy = new Terminal({ cols, rows, allowProposedApi: true });
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0; // PTY bytes, not UTF-16 code units: the output is full of CJK and emoji
  const proc = Bun.spawn(argv, {
    cwd: root,
    env: { ...process.env, TERM: "xterm-256color", ...env },
    terminal: {
      cols,
      rows,
      data(_t, data) {
        const s = decoder.decode(data, { stream: true });
        raw += s;
        bytes += data.byteLength;
        xterm.write(s);
        legacy.write(s);
      },
    },
  });
  xterm.onData((d) => proc.terminal?.write(d));
  const flush = () => Promise.all([xterm, legacy].map((t) => new Promise<void>((r) => t.write("", r))));
  const linesOf = (t: Terminal) => {
    const b = t.buffer.active;
    return Array.from({ length: t.rows }, (_, y) => b.getLine(y)?.translateToString(true) ?? "");
  };
  const lines = () => linesOf(xterm);
  return {
    proc,
    xterm,
    raw: () => raw,
    bytes: () => bytes,
    lines,
    legacyLines: () => linesOf(legacy),
    screen: () => lines().join("\n"),
    send: (s: string) => proc.terminal!.write(s),
    resize(c: number, r: number) {
      proc.terminal!.resize(c, r);
      xterm.resize(c, r);
      legacy.resize(c, r);
    },
    async waitFor(pred: () => boolean, ms: number) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await flush();
        if (pred()) return true;
        await sleep(50);
      }
      await flush();
      return pred();
    },
    async exit(ms: number): Promise<number | "timeout"> {
      const code = await Promise.race([proc.exited, sleep(ms).then(() => "timeout" as const)]);
      if (code === "timeout") proc.kill();
      await flush();
      return code;
    },
  };
}
type Run = ReturnType<typeof launch>;

// x positions of vertical box-drawing borders on row y.
function borderColumns(run: Run, y: number): number[] {
  const line = run.xterm.buffer.active.getLine(y);
  const xs: number[] = [];
  if (!line) return xs;
  for (let x = 0; x < run.xterm.cols; x++) if (/[│┃║]/.test(line.getCell(x)?.getChars() ?? "")) xs.push(x);
  return xs;
}

function restored(s: string, run: Run) {
  const raw = run.raw();
  const leftAlt = raw.lastIndexOf("\x1b[?1049l") > raw.lastIndexOf("\x1b[?1049h");
  check(s, "alternate screen left", leftAlt && run.xterm.buffer.active.type === "normal", `buffer=${run.xterm.buffer.active.type}`);
  check(s, "cursor shown", raw.lastIndexOf("\x1b[?25h") > raw.lastIndexOf("\x1b[?25l"));
  check(s, "mouse tracking off", run.xterm.modes.mouseTrackingMode === "none", run.xterm.modes.mouseTrackingMode);
}

function readReport(path: string): Report | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Report) : null;
}

const eventsOnScreen = (run: Run) => Number(/events (\d+)/.exec(run.screen())?.[1] ?? 0);

const scenarios: Record<string, () => Promise<void>> = {
  async session() {
    const s = "session";
    const report = join(work, "session.json");
    const mark = join(work, "editor.json");
    const run = launch(cmd, 100, 30, {
      TUI_SPIKE_REPORT: report,
      TUI_SPIKE_EDITOR_MARK: mark,
      EDITOR: `"${process.execPath}" "${join(root, "harness/fake-editor.ts")}"`,
    });
    const rendered = await run.waitFor(() => run.screen().includes("pending ("), 15_000);
    check(s, "renders", rendered, run.screen().slice(0, 200));
    // Whatever the TUI printed instead — a load error lives only on this screen.
    if (!rendered) console.log(`--- screen ---\n${run.screen().trimEnd()}\n--------------`);
    check(s, "feed is live (≥ 40 events)", await run.waitFor(() => eventsOnScreen(run) >= 40, 15_000), eventsOnScreen(run));

    // CJK / emoji: every body row keeps its borders in the same columns.
    const text = run.screen();
    check(s, "CJK on screen", text.includes("請確認") && text.includes("返品"));
    const body = Array.from({ length: run.xterm.rows - 3 }, (_, i) => i + 1);
    const want = borderColumns(run, 1).join(",");
    const bad = body.filter((y) => borderColumns(run, y).join(",") !== want);
    check(s, "borders aligned on every row", bad.length === 0, bad.length ? `rows ${bad.join(",")}; want ${want}` : want);

    // Steady state under load, 2 s: bytes written, full clears, and stale
    // cells after emoji (the fixture never puts a letter or digit right after
    // one, so a letter there means the TUI and the terminal disagree on the
    // emoji's width). Sampled every 100 ms, on both width tables.
    const staleRe = /\p{Extended_Pictographic}️?[\p{L}\p{N}]/u;
    const stale = new Set<string>();
    const staleLegacy = new Set<string>();
    const sampler = setInterval(() => {
      for (const l of run.lines()) if (staleRe.test(l)) stale.add(l.trim());
      for (const l of run.legacyLines()) if (staleRe.test(l)) staleLegacy.add(l.trim());
    }, 100);
    const before = run.bytes();
    const clearsBefore = run.raw().split("\x1b[2J").length;
    const eventsBefore = eventsOnScreen(run);
    for (let i = 0; i < 20; i++) {
      run.send("j");
      await sleep(30);
    }
    for (let i = 0; i < 5; i++) {
      run.send("\x1b[6~");
      await sleep(60);
    }
    run.send("G");
    await sleep(2000 - 20 * 30 - 5 * 60);
    clearInterval(sampler);
    await run.waitFor(() => true, 0);
    notes.steadyBytesPerSec = Math.round((run.bytes() - before) / 2);
    // The feed emits 20/s (≈16/s on Windows, whose timers tick every 15.6 ms);
    // a starved event loop drops to ~0. Slow machines land between: the Intel
    // macOS runner renders at ~15 ms/frame and keeps ~9/s.
    const rate = (eventsOnScreen(run) - eventsBefore) / 2;
    notes.eventsPerSecWhileInteracting = rate;
    check(s, "feed keeps up while interacting (≥ 5/s)", rate >= 5, rate);
    notes.staleCellsUnicode6 = staleLegacy.size ? [...staleLegacy].slice(0, 3) : "none";
    const clears = run.raw().split("\x1b[2J").length - clearsBefore;
    check(s, "no full-screen clears while streaming", clears === 0, clears);
    check(s, "no stale cells after emoji (Unicode 11 widths)", stale.size === 0, [...stale].slice(0, 2).join(" | "));
    check(s, "selection moved", await run.waitFor(() => /trace #\d+/.test(run.screen()), 3000));

    // New events are prepended above the selection; after more than a
    // screenful of them the selected row must still be on screen.
    // Sampled 20 times over 2 s: a frame between the insert and the scroll
    // is invisible to a person; a selection that drifts away is not.
    const selectedSeq = /trace #(\d+)/.exec(run.screen())?.[1];
    const rowRe = new RegExp(`│\\s*${selectedSeq}  `);
    await sleep(3000);
    let seen = 0;
    let miss = "";
    for (let i = 0; i < 20; i++) {
      await run.waitFor(() => true, 0);
      if (run.lines().some((l) => rowRe.test(l))) seen++;
      else {
        const seqs = run.lines().map((l) => /^│\s*(\d+)  /.exec(l)?.[1]).filter(Boolean);
        miss = `; on a miss the list showed #${seqs[0]}…#${seqs.at(-1)}`;
      }
      await sleep(100);
    }
    notes.selectedRowVisible = `${seen}/20`;
    check(s, "selected row stays on screen while events stream in", seen >= 18, `#${selectedSeq} visible ${seen}/20${miss}`);

    run.send("e");
    check(s, "editor ran", await run.waitFor(() => existsSync(mark), 15_000));
    const editor = existsSync(mark) ? JSON.parse(readFileSync(mark, "utf8")) : {};
    check(s, "editor had the terminal", editor.stdinTTY && editor.stdoutTTY, JSON.stringify(editor));
    check(s, "TUI back after editor", await run.waitFor(() => run.screen().includes("editor exited 0"), 10_000));

    run.resize(120, 40);
    check(s, "resize 120x40", await run.waitFor(() => run.screen().includes("120x40"), 5000));
    run.resize(60, 20);
    check(s, "resize 60x20", await run.waitFor(() => run.screen().includes("60x20"), 5000));

    run.send("q");
    check(s, "exits 0 on q", (await run.exit(10_000)) === 0);
    restored(s, run);
    const r = readReport(report);
    check(s, "report written", !!r);
    if (r) {
      notes.frames = r.frames;
      notes.widthMethod = r.widthMethod;
      notes.events = r.events;
      check(s, "mounted once", r.mounts === 1, r.mounts);
      check(s, "one feed subscription", r.maxActiveSubscriptions === 1, r.maxActiveSubscriptions);
      check(s, "suspend/resume paired", r.suspends === 1 && r.resumes === 1, `${r.suspends}/${r.resumes}`);
    }
  },

  async ctrlc() {
    const s = "ctrl-c";
    const report = join(work, "ctrlc.json");
    const run = launch(cmd, 100, 30, { TUI_SPIKE_REPORT: report });
    check(s, "renders", await run.waitFor(() => run.screen().includes("pending ("), 15_000));
    run.send("\x03");
    check(s, "exits 130", (await run.exit(10_000)) === 130);
    restored(s, run);
    check(s, "exit reason", readReport(report)?.exitReason === "ctrl-c", readReport(report)?.exitReason);
  },

  async crash() {
    const s = "crash";
    const report = join(work, "crash.json");
    const run = launch(cmd, 100, 30, { TUI_SPIKE_REPORT: report });
    check(s, "renders", await run.waitFor(() => run.screen().includes("pending ("), 15_000));
    run.send("!");
    check(s, "exits 1", (await run.exit(10_000)) === 1);
    restored(s, run);
    check(s, "exit reason", readReport(report)?.exitReason === "uncaughtException", readReport(report)?.exitReason);
  },

  async sigterm() {
    if (isWin) return void (notes.sigterm = "skipped on Windows (no POSIX signals)");
    const s = "sigterm";
    const run = launch(cmd, 100, 30);
    check(s, "renders", await run.waitFor(() => run.screen().includes("pending ("), 15_000));
    run.proc.kill("SIGTERM");
    check(s, "exits 143", (await run.exit(10_000)) === 143);
    restored(s, run);
  },

  // stdout is a TTY but stdin is not: must not open the full-screen UI.
  async stdinRedirected() {
    const s = "stdin redirected";
    // On Windows the redirect goes in a batch file: cmd.exe does not parse
    // the backslash-escaped quotes a spawned argv gets.
    let argv = ["sh", "-c", 'exec "$@" < /dev/null', "sh", ...cmd];
    if (isWin) {
      const bat = join(work, "stdin-nul.cmd");
      writeFileSync(bat, `@${cmd.map((a) => `"${a}"`).join(" ")} < NUL\r\n`);
      argv = ["cmd.exe", "/d", "/c", bat];
    }
    const run = launch(argv, 100, 30);
    check(s, "exits 0", (await run.exit(15_000)) === 0);
    check(s, "no alternate screen", !run.raw().includes("\x1b[?1049h"));
    check(s, "prints the listing", run.lines().filter((l) => /^\d+\s/.test(l)).length >= 5, run.screen().trim().slice(0, 200));
  },

  async nonTty() {
    const s = "no TTY";
    const proc = Bun.spawn(cmd, { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const code = await Promise.race([proc.exited, sleep(15_000).then(() => "timeout" as const)]);
    if (code === "timeout") proc.kill();
    const out = await new Response(proc.stdout).text();
    check(s, "exits 0", code === 0, code);
    check(s, "plain text only", !out.includes("\x1b"));
    check(s, "five lines", out.trim().split("\n").length === 5, JSON.stringify(out.slice(0, 120)));
  },
};

for (const [name, run] of Object.entries(scenarios)) {
  if (only && !only.includes(name)) continue;
  try {
    await run();
  } catch (e) {
    check(name, "scenario threw", false, e instanceof Error ? e.message : e);
  }
}

const failed = checks.filter((c) => !c.ok).length;
const summary = {
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  cmd,
  passed: checks.length - failed,
  failed,
  notes,
  checks,
};
console.log(JSON.stringify({ ...summary, checks: undefined }, null, 2));
if (args.get("out")) writeFileSync(args.get("out")!, JSON.stringify(summary, null, 2));
process.exit(failed);
