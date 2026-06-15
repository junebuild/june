// Local SQLite driver selection — the ONE place that judges which built-in
// sqlite the current runtime provides, decoupled from the host's server/spawn
// concerns (host.ts). Both are zero-install: `bun:sqlite` under Bun, `node:sqlite`
// under Node. This is dev/host-only (the deployed worker binds D1 from env via
// src/d1.ts and never touches this module).
//
// Why a separate layer: the bun-vs-node *driver* choice and the bun-vs-node
// *host* choice happen to share a signal (`typeof Bun`), but they answer
// different questions — and the Node path has a real version cliff that deserves
// one clear error, not a raw ERR_UNKNOWN_BUILTIN_MODULE leaking from a dynamic
// import. Keeping the judgment here means host.ts just delegates.

import type { JuneDb } from "@junejs/core/resources";

// The shape bun:sqlite exposes directly and node:sqlite is adapted to: a
// prepared statement with positional binding.
type SyncStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
};
type SyncSqlite = {
  query(sql: string): SyncStatement;
  exec(sql: string): void;
  close(): void;
};

// node:sqlite landed in v22.5.0 behind --experimental-sqlite, and lost the flag
// in v22.13.0 (the 22 LTS line) and v23.4.0. We need the flag-free builtin, so
// 22.13.0 is the practical floor on LTS; 23.4.0 on the odd line.
export const NODE_SQLITE_MIN_LTS = "22.13.0";
export const NODE_SQLITE_MIN_ODD = "23.4.0";

// Wrap a synchronous SQLite handle as the async JuneDb. The driver work is
// synchronous, but the SURFACE is async, so swapping in D1 later is invisible to
// every caller. (Moved here from host.ts with the driver it serves.)
function asyncSqlite(db: SyncSqlite): JuneDb {
  // Prepared-statement cache, keyed by SQL string — compile-once at the driver:
  // parse + bytecode-compile each query ONCE, then re-bind. Essential on the
  // node:sqlite path (`db.query` = `db.prepare`, which re-compiles every call);
  // harmless on bun:sqlite (it already caches `query()` internally). The app's set
  // of query SHAPES is finite (Juno compiles one per shape), so this stays bounded.
  // Statements re-bind across calls — exactly what sqlite prepares are for.
  const stmts = new Map<string, SyncStatement>();
  const prep = (sql: string): SyncStatement => {
    let s = stmts.get(sql);
    if (!s) {
      s = db.query(sql);
      stmts.set(sql, s);
    }
    return s;
  };
  const self: JuneDb = {
    dialect: "sqlite",
    async query<T>(sql: string, params: unknown[] = []) {
      return prep(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      // Normalize "no row" to undefined — bun:sqlite returns null, node:sqlite
      // returns undefined; the seam hides the difference.
      return (prep(sql).get(...params) ?? undefined) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      const r = prep(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid ?? 0 };
    },
    async exec(sql: string) {
      db.exec(sql); // DDL / multi-statement — not a cacheable prepared statement
    },
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      db.exec("BEGIN");
      try {
        const out = await fn(self); // same connection — sqlite is single-writer
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async close() {
      stmts.clear();
      db.close();
    },
  };
  return self;
}

// The actionable message when Node can't provide node:sqlite — the bad-first-run
// path this layer exists to fix. Pure + exported so it is unit-testable without
// an old Node. `nodeVersion` is process.versions.node (e.g. "20.11.0").
export function nodeSqliteHelp(nodeVersion: string): string {
  return [
    `June's local database needs Node's built-in sqlite (node:sqlite), which this`,
    `runtime can't load. You're on Node v${nodeVersion}.`,
    ``,
    `node:sqlite is available without a flag in Node >= ${NODE_SQLITE_MIN_LTS} (LTS) or`,
    `>= ${NODE_SQLITE_MIN_ODD}. Node 22.5–22.12 / 23.0–23.3 have it behind`,
    `--experimental-sqlite, and older Node doesn't ship it at all.`,
    ``,
    `Fix it one of two ways:`,
    `  • Upgrade Node to ${NODE_SQLITE_MIN_LTS}+ (recommended), or`,
    `  • Run June with Bun — bun:sqlite is built in, no flag, no version floor.`,
  ].join("\n");
}

// --- silencing node:sqlite's one-time ExperimentalWarning -------------------
// Node prints `ExperimentalWarning: SQLite is an experimental feature` the first
// time node:sqlite loads. We guard the version, so we KNOW it works here — the
// warning is just first-run noise. Silence ONLY that one line; every other
// warning (deprecations, other experimentals) must still pass through.

// True for exactly Node's node:sqlite ExperimentalWarning. Pure + exported so
// the filter is unit-testable without triggering a real warning.
export function isNodeSqliteExperimentalWarning(type: unknown, message: string): boolean {
  return type === "ExperimentalWarning" && /sqlite/i.test(message);
}

type EmitWarning = (warning: string | Error, ...rest: unknown[]) => void;

// Wrap an emitWarning impl so the node:sqlite experimental warning is dropped
// and everything else is forwarded verbatim.
export function makeWarningFilter(original: EmitWarning): EmitWarning {
  return (warning, ...rest) => {
    const message = typeof warning === "string" ? warning : (warning?.message ?? "");
    // emitWarning(warning, type?) or emitWarning(warning, { type }) — read both.
    const first = rest[0];
    const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
    if (isNodeSqliteExperimentalWarning(type, message)) return;
    original(warning, ...rest);
  };
}

// bun-types declares the global `Bun`; on Node the binding doesn't exist at
// runtime, which is exactly what the typeof guard checks.
declare const Bun: unknown;

// Open a LOCAL sqlite file (or ":memory:") on whichever runtime we're under.
// The single seam host.openDb() delegates to.
export async function openLocalSqlite(path: string): Promise<JuneDb> {
  if (typeof Bun !== "undefined") {
    // Non-literal specifier so a bundler can't FOLLOW bun:sqlite into a Node
    // build (it only exists under Bun, and is only reached under Bun).
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as {
      Database: new (p: string, o?: { create?: boolean }) => SyncSqlite;
    };
    return asyncSqlite(new Database(path, { create: true }));
  }

  // Node: node:sqlite is a builtin, but only flag-free on a recent-enough
  // version. A failed import here is the version cliff — translate it to guidance
  // instead of letting ERR_UNKNOWN_BUILTIN_MODULE / "needs --experimental-sqlite"
  // surface raw.
  const specifier = "node:sqlite";
  let mod: { DatabaseSync: new (p: string) => { prepare(sql: string): SyncStatement; exec(sql: string): void; close(): void } };
  // Drop the SQLite ExperimentalWarning that fires during this import, restoring
  // the original handler immediately after so no other warning is affected.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = makeWarningFilter(
    originalEmitWarning.bind(process) as EmitWarning,
  ) as typeof process.emitWarning;
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch (cause) {
    throw new Error(nodeSqliteHelp(process.versions.node), { cause });
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  const db = new mod.DatabaseSync(path);
  // Adapt node:sqlite (prepare()) to the query()-shaped SyncSqlite surface.
  return asyncSqlite({
    query: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
}
