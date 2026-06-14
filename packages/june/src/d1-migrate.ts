// Apply June migrations to a REMOTE D1 at deploy time.
//
// The dev `db` opens locally (sqlite().open()); D1's binding only exists inside
// workerd at request time, so the deploy host can't `factory.open()` it. Instead
// we reach D1 out-of-band through `wrangler d1 execute --remote`, wrapped as a
// JuneDb — so the SAME migrate() (same ledger, same destructive classifier the
// dev path uses) runs against production unchanged. dev and prod converge on one
// ordered ledger; the only difference is the transport.
//
// HOST-ONLY: spawns wrangler + writes temp files (node:*). Imported by deploy.ts,
// which is never in the worker graph — keep it that way.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { JuneDb, RunResult } from "@junejs/core/resources";

import { migrate, type MigrateResult } from "./migrate";

// One `wrangler d1 execute` invocation. `mode:"command"` passes SQL inline (with
// --json so we can read results/meta); `mode:"file"` writes a temp .sql and uses
// --file (right for DDL + multi-statement migration bodies). Injectable so tests
// drive the adapter without spawning wrangler or touching the network.
export type D1Exec = (req: {
  sql: string;
  mode: "command" | "file";
  json: boolean;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// `?`-placeholder binding isn't available over `d1 execute --command`, so inline
// the params ourselves. Only used for the framework's own ledger ops (controlled
// values), but escape properly regardless.
export function inlineParams(sql: string, params: readonly unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const p = params[i++];
    if (p === null || p === undefined) return "null";
    if (typeof p === "number" || typeof p === "bigint") return String(p);
    if (typeof p === "boolean") return p ? "1" : "0";
    return `'${String(p).replace(/'/g, "''")}'`;
  });
}

// wrangler --json prints a `[{ results, success, meta }]` array on stdout (one
// element per statement; we read the first, since our --command calls are always
// single-statement ledger ops). The clean case is pure JSON, but wrangler can
// emit a banner/notice first — so fall back to parsing from the last line that
// opens an array (the JSON is the last top-level value).
function parseD1Json(stdout: string): { results: unknown[]; meta: Record<string, number> } {
  type Row = { results?: unknown[]; meta?: Record<string, number> };
  const pick = (arr: Row[]) => {
    const f = arr[0] ?? {};
    return { results: f.results ?? [], meta: f.meta ?? {} };
  };
  const trimmed = stdout.trim();
  try {
    return pick(JSON.parse(trimmed) as Row[]); // common case: pure JSON
  } catch {
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trimStart().startsWith("[")) {
        try {
          return pick(JSON.parse(lines.slice(i).join("\n")) as Row[]);
        } catch {
          /* a nested array opener — keep scanning upward for the real one */
        }
      }
    }
    throw new Error(`wrangler d1 execute: no JSON array in output:\n${stdout}`);
  }
}

// The default transport: build the real argv and spawn wrangler. database is the
// D1 `database_name`; configPath pins which wrangler config (and thus account)
// the binding resolves against.
function defaultExec(opts: {
  database: string;
  configPath: string;
  cwd: string;
  wranglerVersion: string;
}): D1Exec {
  return async ({ sql, mode, json }) => {
    const base = [
      "bunx",
      `wrangler@${opts.wranglerVersion}`,
      "d1",
      "execute",
      opts.database,
      "--remote",
      "--config",
      opts.configPath,
    ];
    let tmpDir: string | undefined;
    if (mode === "file") {
      tmpDir = await mkdtemp(join(tmpdir(), "june-d1-"));
      const tmp = join(tmpDir, "migration.sql");
      await writeFile(tmp, sql);
      base.push("--file", tmp);
    } else {
      base.push("--command", sql);
    }
    if (json) base.push("--json");
    try {
      const proc = Bun.spawn(base, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    }
  };
}

// A JuneDb backed by `wrangler d1 execute`. query/get/run go through --command
// (+ --json); exec (DDL, migration bodies) goes through --file.
export function wranglerD1(opts: {
  database: string;
  configPath: string;
  cwd: string;
  wranglerVersion?: string;
  exec?: D1Exec;
}): JuneDb {
  const exec = opts.exec ?? defaultExec({ ...opts, wranglerVersion: opts.wranglerVersion ?? "4.99.0" });
  const fail = (r: { stderr: string; stdout: string; exitCode: number }) => {
    throw new Error(`wrangler d1 execute failed (exit ${r.exitCode})\n${r.stderr || r.stdout}`.trim());
  };
  const db: JuneDb = {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await exec({ sql: inlineParams(sql, params), mode: "command", json: true });
      if (r.exitCode !== 0) fail(r);
      return parseD1Json(r.stdout).results as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return ((await db.query<T>(sql, params))[0] ?? undefined) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const r = await exec({ sql: inlineParams(sql, params), mode: "command", json: true });
      if (r.exitCode !== 0) fail(r);
      const { meta } = parseD1Json(r.stdout);
      return { changes: meta.changes ?? 0, lastInsertRowid: meta.last_row_id ?? 0 };
    },
    async exec(sql: string) {
      const r = await exec({ sql, mode: "file", json: false });
      if (r.exitCode !== 0) fail(r);
    },
    // D1 has no interactive transactions; run inline (same as the edge d1()
    // adapter). Migrations are one-statement-script-per-file anyway.
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      return fn(db);
    },
    async close() {
      /* nothing to close — each call is its own wrangler invocation */
    },
  };
  return db;
}

// Resolve which D1 database `june deploy` should migrate. The wrangler config that
// will be deployed is the source of truth; fall back to the name `june build`
// derives (`<app>-db`) when the config is TOML or has no d1 binding declared.
export async function resolveD1Database(appRoot: string, configPath: string): Promise<string | null> {
  try {
    const raw = await Bun.file(configPath).text();
    if (/\.jsonc?$/.test(configPath)) {
      const json = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const cfg = JSON.parse(json) as { d1_databases?: Array<{ database_name?: string }> };
      const name = cfg.d1_databases?.[0]?.database_name;
      if (name) return name;
    }
  } catch {
    /* fall through to the derived default */
  }
  const pkgPath = join(appRoot, "package.json");
  let pkgName: string | undefined;
  try {
    pkgName = (JSON.parse(await Bun.file(pkgPath).text()) as { name?: string }).name;
  } catch {
    /* no package.json — use the directory name */
  }
  const defaultName = (pkgName ?? basename(appRoot)).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `${defaultName}-db`;
}

// Open the remote D1 as a JuneDb and run the app's db/migrations against it —
// the same migrate() the dev path uses, so the destructive gate behaves
// identically (blocked → returned, not applied).
export async function migrateD1(opts: {
  appRoot: string;
  database: string;
  configPath: string;
  allowDestructive?: boolean;
  exec?: D1Exec;
  now?: string;
}): Promise<MigrateResult> {
  const db = wranglerD1({
    database: opts.database,
    configPath: opts.configPath,
    cwd: opts.appRoot,
    exec: opts.exec,
  });
  return migrate(db, join(opts.appRoot, "db", "migrations"), {
    allowDestructive: opts.allowDestructive,
    now: opts.now,
  });
}
