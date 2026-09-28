// Stands in for $EDITOR in the harness: proves the child got the terminal
// (inherited stdio) and that the draft file round-trips, then exits 0.
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (file) appendFileSync(file, "\n-- edited by fake editor\n");
const mark = process.env.TUI_SPIKE_EDITOR_MARK;
if (mark) writeFileSync(mark, JSON.stringify({ file, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY }));
