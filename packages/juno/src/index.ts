// Juno — June's ergonomic data layer. A typed table API over the @junejs/core
// JuneDb contract (so it works over sqlite / D1 / Postgres alike), depending ONLY
// on @junejs/core (inward; @junejs/core never imports Juno). docs/data-layer-boundary.md.
//
// THE MAGIC (Tier 3): every read calls recordTableRead, every write
// recordTableWrite — @junejs/core's PUBLIC trace contract. That is what makes cache
// auto-tag by table and a mutation auto-invalidate + push live RSC, with zero
// manual revalidate(). Juno emits these natively; Drizzle/Prisma reach the same
// tier with a thin shim. The framework depends on the trace contract, not on Juno.

import type { JuneDb, RunResult } from "@junejs/core/resources";
import { recordTableRead, recordTableWrite } from "@junejs/core/instrumentation";

import { db as ambientDb, requestLocal, registerSqlTagger } from "@junejs/db";

import { tableLoader, tableListLoader, type Loader, type ListLoader } from "./batch";
import { sqlite } from "./compiler";
import { taggingDb, tagSql } from "./tag";

// Importing Juno upgrades the canonical ambient `db` to auto-tag raw queries (a
// raw read inside cache() then auto-invalidates). The framework re-exports that
// same `db`, so `import { db } from "@junejs/server"` is the tagging one in a Juno
// app — without the framework ever importing Juno.
registerSqlTagger(tagSql);

export { createLoader, createGroupLoader, tableLoader, tableListLoader, type Loader, type ListLoader } from "./batch";
export { tablesFromSql, tagSql, taggingDb, type SqlTouch } from "./tag";
export { Dialect, SqliteDialect, sqlite, ident } from "./compiler";
export type { Node, SelectNode, InsertNode, UpdateNode, DeleteNode, UpsertNode } from "./ast";

export type Row = Record<string, unknown>;

export class Table<T extends Row = Row> {
  constructor(
    private readonly db: JuneDb,
    private readonly name: string,
    // Per-request ambient-loader registry, shared across the juno() handle's
    // .table() calls so concurrent findBy/all coalesce. Holds both point and list
    // loaders (keyed apart). Optional/defaulted so a standalone `new Table(db,
    // name)` still works (it just batches alone).
    private readonly loaders: Map<string, unknown> = new Map(),
  ) {}

  // No `where` → every row. With a `where`, the list of rows matching it (the list
  // counterpart of findBy, same where syntax). A single-column filter ambient-
  // batches like findBy — concurrent `all({user_id})` across components coalesce
  // into one `where user_id in (...)` grouped by key (list N+1 → 1).
  async all(where?: Partial<T>): Promise<T[]> {
    recordTableRead(this.name); // auto-tag: a cache() around this gets table:<name>
    const keys = where ? Object.keys(where) : [];
    const [col] = keys;
    if (keys.length === 1 && col !== undefined) {
      return this.ambientListLoader(col).load((where as Row)[col] as string | number) as Promise<T[]>;
    }
    const sql = sqlite.compile({ kind: "select", from: this.name, where: keys });
    return this.db.query<T>(sql, where ? Object.values(where) : []);
  }

  async findBy(where: Partial<T>): Promise<T | undefined> {
    recordTableRead(this.name); // sync, in-trace: cache() auto-tags table:<name> here
    const keys = Object.keys(where);
    // Ambient auto-batch: a single-column equality lookup coalesces with other
    // concurrent findBy on the same (table, column) this request into ONE
    // `where col in (...)` query — N+1 → 1, with no loader to manage. There is no
    // cross-tick cache, so a read AFTER a write (a later tick) re-queries and sees
    // the new value. Multi-column or empty `where` falls back to a direct query.
    const [col] = keys;
    if (keys.length === 1 && col !== undefined) {
      const hit = await this.ambientLoader(col).load((where as Row)[col] as string | number);
      return (hit ?? undefined) as T | undefined;
    }
    const sql = sqlite.compile({ kind: "select", from: this.name, where: keys, limit: 1 });
    return this.db.get<T>(sql, Object.values(where));
  }

  // get-or-create the per-request ambient loader for (table, column). tableLoader
  // validates both identifiers and emits recordTableRead in its batch.
  private ambientLoader(col: string): Loader<string | number, T> {
    const key = `${this.name}::${col}`;
    let loader = this.loaders.get(key);
    if (!loader) {
      loader = tableLoader<Row>(this.db, this.name, col);
      this.loaders.set(key, loader);
    }
    return loader as Loader<string | number, T>;
  }

  // get-or-create the per-request ambient LIST loader for (table, column). Keyed
  // apart from the point loader (`list:` prefix) — they coalesce different shapes.
  private ambientListLoader(col: string): ListLoader<string | number, T> {
    const key = `list:${this.name}::${col}`;
    let loader = this.loaders.get(key);
    if (!loader) {
      loader = tableListLoader<Row>(this.db, this.name, col);
      this.loaders.set(key, loader);
    }
    return loader as ListLoader<string | number, T>;
  }

  async insert(values: Partial<T>): Promise<RunResult> {
    recordTableWrite(this.name); // auto-invalidate: invokeAction drops table:<name>
    const sql = sqlite.compile({ kind: "insert", into: this.name, columns: Object.keys(values) });
    return this.db.run(sql, Object.values(values));
  }

  // Atomic insert-or-update: insert `values`; on a conflict of the `onConflict`
  // column(s), update the other provided columns to the new values. Returns the
  // upserted row (via RETURNING) in ONE round trip — the primitive that removes
  // the findBy-then-insert footgun (eval A2/A3). If every provided column is a
  // conflict key, it no-ops the update so RETURNING still yields the existing row
  // (a get-or-create).
  async upsert(values: Partial<T>, opts: { onConflict: string | string[] }): Promise<T | undefined> {
    recordTableWrite(this.name);
    const columns = Object.keys(values);
    const conflict = Array.isArray(opts.onConflict) ? opts.onConflict : [opts.onConflict];
    const updates = columns.filter((c) => !conflict.includes(c));
    const update = updates.length ? updates : conflict;
    const sql = sqlite.compile({ kind: "upsert", into: this.name, columns, conflict, update });
    return this.db.get<T>(sql, Object.values(values));
  }

  async update(where: Partial<T>, values: Partial<T>): Promise<RunResult> {
    recordTableWrite(this.name);
    const sql = sqlite.compile({
      kind: "update",
      table: this.name,
      set: Object.keys(values),
      where: Object.keys(where),
    });
    return this.db.run(sql, [...Object.values(values), ...Object.values(where)]);
  }

  async delete(where: Partial<T>): Promise<RunResult> {
    recordTableWrite(this.name);
    const sql = sqlite.compile({ kind: "delete", from: this.name, where: Object.keys(where) });
    return this.db.run(sql, Object.values(where));
  }

  // A per-request by-key loader: concurrent .load(key) calls during one render
  // pass coalesce into a single `where key in (...)` query (N+1 → 1). Build one
  // per request so keys never leak across requests.
  loader(key = "id"): Loader<string | number, T> {
    return tableLoader<T>(this.db, this.name, key);
  }
}

export type Juno = {
  table<T extends Row = Row>(name: string): Table<T>;
  // Raw escape hatch. Reads/writes through it auto-tag by parsed table name, so a
  // `cache(() => db.query("select ... from posts"))` is invalidated by a posts
  // write instead of going silently stale.
  db: JuneDb;
  // Explicit tag escape hatch for SQL the parser can't classify (CTEs over a
  // function, dynamic table names, a read computed outside SQL). `reads()` makes a
  // cache() pick up the tag; `writes()` invalidates it. Explicit, so it can't
  // silently break — the failure mode the implicit-only design had.
  reads(...tables: string[]): void;
  writes(...tables: string[]): void;
};

// Wrap any JuneDb handle (ctx.db) in Juno's ergonomic surface. Build ONE per
// request: the ambient-loader registry it carries is what makes concurrent
// findBy across components coalesce — and scoping it to the per-request handle
// is what keeps keys from leaking across requests.
export function juno(db: JuneDb): Juno {
  const loaders = new Map<string, unknown>();
  return {
    // Table API uses the raw db and tags explicitly (precise, parser-independent);
    // the exposed handle wraps it so the raw escape hatch auto-tags too.
    db: taggingDb(db),
    table<T extends Row = Row>(name: string) {
      return new Table<T>(db, name, loaders);
    },
    reads(...tables: string[]) {
      for (const t of tables) recordTableRead(t);
    },
    writes(...tables: string[]) {
      for (const t of tables) recordTableWrite(t);
    },
  };
}

// --- Ambient surface (the framework-native way) --------------------------------
// Matches June's ambient resources (`import { db } from "@junejs/db"`): no handle
// to thread or mis-scope. `table()` reads the ambient `db` resource and a
// per-request loader registry kept in the request scope, so batching is
// STRUCTURALLY per-request and unstashable — the leak A3 found can't happen.
// Use inside a request scope (a loader/view/action); throws otherwise, like `db`.
const LOADERS = Symbol.for("junejs.juno.loaders");

export function table<T extends Row = Row>(name: string): Table<T> {
  const loaders = requestLocal(LOADERS, () => new Map<string, unknown>());
  return new Table<T>(ambientDb, name, loaders);
}

// No separate ambient `db` export: the canonical `db` from `@junejs/db` (and
// re-exported by `@junejs/server`) auto-tags once Juno is imported (above), so
// there is exactly one `db` to import. `taggingDb` remains for the explicit
// `juno(handle)` path, where it wraps a caller-supplied handle.

// Explicit tag/invalidate hatch, ambiently (no handle needed — they only record).
export function reads(...tables: string[]): void {
  for (const t of tables) recordTableRead(t);
}
export function writes(...tables: string[]): void {
  for (const t of tables) recordTableWrite(t);
}
