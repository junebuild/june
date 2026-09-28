// Markdown summary of every results-*.json in the spike directory, for the
// GitHub job summary.  bun harness/summary.ts <target>

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Result = {
  platform: string;
  arch: string;
  passed: number;
  failed: number;
  notes: {
    frames?: { avgMs: number; maxMs: number } | null;
    widthMethod?: string;
    steadyBytesPerSec?: number;
    staleCellsUnicode6?: string[] | string;
  };
  checks: { scenario: string; name: string; ok: boolean; detail?: string }[];
};

const root = resolve(import.meta.dir, "..");
const target = process.argv[2] ?? "";
const variants = ["source", "compiled", "npm", "bun"];

console.log(`### ${target}\n`);
console.log("| path | runtime | result | frame avg / max | width | bytes/s | stale cells on Unicode 6 |");
console.log("|---|---|---|---|---|---|---|");
const failures: string[] = [];
for (const v of variants) {
  const file = join(root, `results-${v}.json`);
  if (!existsSync(file)) {
    console.log(`| ${v} | — | not run | | | | |`);
    continue;
  }
  const r = JSON.parse(readFileSync(file, "utf8")) as Result;
  const f = r.notes.frames;
  const stale = Array.isArray(r.notes.staleCellsUnicode6) ? `${r.notes.staleCellsUnicode6.length}+ rows` : (r.notes.staleCellsUnicode6 ?? "");
  console.log(
    `| ${v} | ${r.platform}-${r.arch} | ${r.failed ? "❌" : "✅"} ${r.passed}/${r.passed + r.failed} | ${f ? `${f.avgMs.toFixed(1)} / ${f.maxMs.toFixed(1)} ms` : ""} | ${r.notes.widthMethod ?? ""} | ${r.notes.steadyBytesPerSec ?? ""} | ${stale} |`,
  );
  for (const c of r.checks.filter((c) => !c.ok)) failures.push(`- **${v}** · ${c.scenario} · ${c.name}${c.detail ? ` — \`${c.detail.slice(0, 160)}\`` : ""}`);
}
if (failures.length) console.log(`\n**Failures**\n\n${failures.join("\n")}`);
console.log("");
