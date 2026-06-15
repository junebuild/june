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

import type { DataLayer } from "@junejs/core/config";
import { db as ambientDb, requestLocal, registerSqlTagger } from "@junejs/db";

import type { Predicate, SelectNode } from "./ast";
import { tableLoader, tableListLoader, type Loader, type ListLoader } from "./batch";
import { sqlite } from "./compiler";
import { taggingDb, tagSql } from "./tag";
import { emitSchemaTypes } from "./types";

export { createLoader, createGroupLoader, tableLoader, tableListLoader, type Loader, type ListLoader } from "./batch";
export { tablesFromSql, tagSql, taggingDb, type SqlTouch } from "./tag";
export { Dialect, SqliteDialect, PostgresDialect, sqlite, postgres, ident } from "./compiler";
export { emitSchemaTypes } from "./types";
export type { Node, SelectNode, InsertNode, UpdateNode, DeleteNode, UpsertNode } from "./ast";

export type Row = Record<string, unknown>;

// The app's table → row-type registry (Stage 3). EMPTY by default, so `table(name)`
// stays untyped and every existing call keeps working (back-compat). Apps augment it
// via `declare module "@junejs/juno" { interface Schema { users: {...} } }` — a file
// `june db types` generates by introspecting the live schema (Stage 3b). Once
// augmented, `table("users")` autocompletes the name and infers the row, with no
// inline generic and no handle. Kysely-style declaration merging: zero runtime, and
// the schema of record stays in SQL (db/migrations/), never owned by Juno.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Schema {}

// A known table name resolves to its declared row (intersected with Row so it always
// satisfies the Table constraint); falls back to `never` when Schema is empty, which
// makes the typed overload simply not match and the string overload take over.
export type TableNames = keyof Schema & string;
export type RowOf<K extends TableNames> = Schema[K] & Row;

// A WHERE value is either an equality value or an operator object (Stage 2).
// `{ age: { gte: 18 }, name: { like: "%a%" }, id: { in: [1, 2] } }` — AND-joined.
export type Operators = {
  eq?: unknown;
  ne?: unknown;
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  in?: unknown[];
  like?: string;
};
export type Where<T> = { [K in keyof T]?: T[K] | Operators };
export type OrderBy<T> = { [K in keyof T]?: "asc" | "desc" };

const OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "like"]);
// An operator object is a non-array object (sqlite values are primitives, so a
// non-array object in a WHERE position means operators, not a bound value).
function isOperators(v: unknown): v is Operators {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

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
  async all(
    where?: Where<T>,
    opts?: { orderBy?: OrderBy<T>; limit?: number; offset?: number },
  ): Promise<T[]> {
    recordTableRead(this.name); // auto-tag: a cache() around this gets table:<name>
    const w = (where ?? {}) as Row;
    const keys = Object.keys(w);
    const [col] = keys;
    // Ambient batch only for a single-column EQUALITY filter with no opts —
    // operators / multi-column / order / limit fall through to a direct query.
    if (!opts && keys.length === 1 && col !== undefined && !isOperators(w[col])) {
      return this.ambientListLoader(col).load(w[col] as string | number) as Promise<T[]>;
    }

    const predicates: Predicate[] = [];
    const params: unknown[] = [];
    for (const c of keys) {
      const v = w[c];
      if (isOperators(v)) {
        for (const op of Object.keys(v)) {
          if (!OPS.has(op)) throw new Error(`unknown operator: ${op}`);
          const operand = (v as Record<string, unknown>)[op];
          if (op === "in") {
            const arr = operand as unknown[];
            predicates.push({ col: c, op: "in", arity: arr.length });
            params.push(...arr);
          } else {
            predicates.push({ col: c, op: op as Exclude<keyof Operators, "in"> });
            params.push(operand);
          }
        }
      } else {
        predicates.push({ col: c, op: "eq" });
        params.push(v);
      }
    }

    const orderBy = opts?.orderBy
      ? (Object.entries(opts.orderBy) as [string, "asc" | "desc"][]).map(([c, dir]) => ({ col: c, dir }))
      : undefined;
    const node: SelectNode = {
      kind: "select",
      from: this.name,
      where: predicates,
      orderBy,
      limit: opts?.limit != null ? "param" : undefined,
      offset: opts?.offset != null ? "param" : undefined,
    };
    if (opts?.limit != null) params.push(opts.limit);
    if (opts?.offset != null) params.push(opts.offset);
    return this.db.query<T>(sqlite.compile(node), params);
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
    const where2: Predicate[] = keys.map((k) => ({ col: k, op: "eq" }));
    const sql = sqlite.compile({ kind: "select", from: this.name, where: where2, limit: 1 });
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
  // Schema-aware: a declared table name infers its row (and autocompletes). The
  // string overload is the fallback for dynamic names / an empty Schema / an
  // explicit inline generic (`table<Custom>("x")`).
  table<K extends TableNames>(name: K): Table<RowOf<K>>;
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
  function table<K extends TableNames>(name: K): Table<RowOf<K>>;
  function table<T extends Row = Row>(name: string): Table<T>;
  function table(name: string): Table {
    return new Table(db, name, loaders);
  }
  return {
    // Table API uses the raw db and tags explicitly (precise, parser-independent);
    // the exposed handle wraps it so the raw escape hatch auto-tags too.
    db: taggingDb(db),
    table,
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

// The boot wiring: register Juno's SQL tagger so the canonical ambient `db`
// auto-tags raw queries. `june build` imports THIS by name into the worker.
export function installDataLayer(): void {
  registerSqlTagger(tagSql);
}

// Declare Juno as the app's data layer in june.config.ts: `dataLayer: junoDataLayer()`.
// The dev host calls install() at boot; `june build` emits installDataLayer() into
// the worker (via `module`). Explicit (config-declared), NOT an import-time global
// side-effect — and the framework still never imports Juno (the user's config does).
export function junoDataLayer(): DataLayer {
  // emitTypes: `june db types` introspects the migrated db through this hook and
  // writes db/schema.d.ts — the framework calls it via the DataLayer seam, still
  // never importing Juno. See src/types.ts.
  return { install: installDataLayer, module: "@junejs/juno", emitTypes: emitSchemaTypes };
}

export function table<K extends TableNames>(name: K): Table<RowOf<K>>;
export function table<T extends Row = Row>(name: string): Table<T>;
export function table(name: string): Table {
  const loaders = requestLocal(LOADERS, () => new Map<string, unknown>());
  return new Table(ambientDb, name, loaders);
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
