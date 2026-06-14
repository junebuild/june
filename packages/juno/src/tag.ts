// Best-effort extraction of the table(s) a SQL statement touches, so RAW queries
// through the juno handle participate in the same auto-tag / auto-invalidate as
// the typed table API — closing the "raw query inside cache() is silently stale"
// gap (positioning Appendix 3). Heuristic by design: it covers single-table reads,
// JOINs, and the three write verbs. Anything it can't classify falls back to the
// explicit j.reads()/j.writes() escape hatch, so the failure mode is "developer
// tags it" — never silent staleness slipping past a correct-looking call.

import { recordTableRead, recordTableWrite } from "@junejs/core/instrumentation";
import type { JuneDb } from "@junejs/core/resources";

export type SqlTouch = { kind: "read" | "write" | "other"; tables: string[] };

// A table reference: optional quote/bracket, an identifier that may be schema-qualified.
const TABLE = "[`\"'\\[]?([A-Za-z_][\\w.]*)[`\"'\\]]?";

// schema.table -> table (tags use the bare name, as the table API does)
function bare(token: string): string {
  const dot = token.lastIndexOf(".");
  return dot >= 0 ? token.slice(dot + 1) : token;
}

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\s+/g, " ")
    .trim();
}

function collect(sql: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(re)) if (m[1]) out.add(bare(m[1]));
  return [...out];
}

// Classify a statement by its leading verb and pull the table(s) it touches.
export function tablesFromSql(sqlRaw: string): SqlTouch {
  const sql = normalize(sqlRaw);
  const verb = (sql.match(/^(\w+)/)?.[1] ?? "").toLowerCase();
  switch (verb) {
    case "select":
    case "with": // CTE names may over-match → over-invalidate (safe), never under
      return { kind: "read", tables: collect(sql, new RegExp(`\\b(?:from|join)\\s+${TABLE}`, "gi")) };
    case "insert":
      return { kind: "write", tables: collect(sql, new RegExp(`\\binto\\s+${TABLE}`, "gi")) };
    case "update":
      return { kind: "write", tables: collect(sql, new RegExp(`^update\\s+${TABLE}`, "gi")) };
    case "delete":
      return { kind: "write", tables: collect(sql, new RegExp(`\\bfrom\\s+${TABLE}`, "gi")) };
    default:
      return { kind: "other", tables: [] };
  }
}

// Record the reads/writes a raw statement implies, for cache auto-tag/invalidate.
export function tagSql(sql: string): void {
  const t = tablesFromSql(sql);
  if (t.kind === "read") for (const name of t.tables) recordTableRead(name);
  else if (t.kind === "write") for (const name of t.tables) recordTableWrite(name);
}

// Wrap a JuneDb so raw query/get/run auto-tag by parsed table name. The typed
// table API keeps tagging explicitly (precise, parser-independent); this covers
// the raw escape hatch so `cache(() => db.query("select ... from posts"))` is
// invalidated by a posts write instead of going silently stale.
//
// A PROXY, not a spread: the ambient `db` resource is itself a Proxy whose methods
// come from a get-trap, so `{ ...db }` would drop exec/transaction/close. The
// Proxy forwards everything to the underlying handle and only wraps query/get/run.
export function taggingDb(db: JuneDb): JuneDb {
  const query = <T = unknown>(sql: string, params?: unknown[]) => (tagSql(sql), db.query<T>(sql, params));
  const get = <T = unknown>(sql: string, params?: unknown[]) => (tagSql(sql), db.get<T>(sql, params));
  const run = (sql: string, params?: unknown[]) => (tagSql(sql), db.run(sql, params));
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "query") return query;
      if (prop === "get") return get;
      if (prop === "run") return run;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
