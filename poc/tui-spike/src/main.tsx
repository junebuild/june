#!/usr/bin/env bun
// Entry point. Opens the TUI only when both stdin and stdout are TTYs
// (docs/rfc-email.md §9.3); otherwise prints a text listing and exits.

// First: ES modules evaluate in import order, and this must set
// OPENTUI_LIBC before @opentui/core resolves its native package.
import "./libc";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { startFeedServer, subscribe } from "./feed";
import { metrics, type Report } from "./metrics";

const RATE = Number(process.env.TUI_SPIKE_RATE ?? 20);
const server = startFeedServer(RATE);
const feedUrl = `http://127.0.0.1:${server.port}/events`;

if (!(process.stdin.isTTY && process.stdout.isTTY)) {
  const ac = new AbortController();
  let n = 0;
  for await (const e of subscribe(feedUrl, ac.signal)) {
    process.stdout.write(`${e.seq}\t${e.from}\t${e.subject}\n`);
    if (++n >= 5) break;
  }
  ac.abort();
  server.stop(true);
  process.exit(0);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, gatherStats: true, targetFps: 30 });

let done = false;
function shutdown(reason: string, code: number, error?: unknown): never {
  if (!done) {
    done = true;
    metrics.exitReason = reason;
    const stats = renderer.getStats();
    try {
      renderer.destroy();
    } finally {
      writeReport(stats);
      if (error) console.error(error);
      server.stop(true);
    }
  }
  process.exit(code);
}

function writeReport(stats: ReturnType<typeof renderer.getStats>) {
  const path = process.env.TUI_SPIKE_REPORT;
  if (!path) return;
  const report: Report = {
    ...metrics,
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    widthMethod: String(renderer.widthMethod),
    frames: stats
      ? { count: stats.frameCount, avgMs: stats.averageFrameTime, maxMs: stats.maxFrameTime, fps: stats.fps }
      : null,
  };
  writeFileSync(path, JSON.stringify(report, null, 2));
}

process.on("SIGTERM", () => shutdown("SIGTERM", 143));
process.on("SIGHUP", () => shutdown("SIGHUP", 129));
process.on("SIGINT", () => shutdown("SIGINT", 130));
process.on("uncaughtException", (e) => shutdown("uncaughtException", 1, e));
process.on("unhandledRejection", (e) => shutdown("unhandledRejection", 1, e));

// $EDITOR without a shell: split on whitespace, honoring double quotes, so
// `code --wait` and a quoted Windows path both work.
function splitCommand(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

function openEditor(text: string): number {
  const dir = mkdtempSync(join(tmpdir(), "tui-spike-"));
  const file = join(dir, "draft.md");
  writeFileSync(file, text);
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  renderer.suspend();
  metrics.suspends++;
  let code: number;
  try {
    code = Bun.spawnSync([...splitCommand(editor), file], { stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? -1;
  } finally {
    renderer.resume();
    metrics.resumes++;
  }
  metrics.editorExit = code;
  return code;
}

createRoot(renderer).render(<App feedUrl={feedUrl} openEditor={openEditor} quit={(r, c) => shutdown(r, c)} />);
