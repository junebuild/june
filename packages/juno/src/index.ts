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

import { tableLoader, type Loader } from "./batch";

export { createLoader, tableLoader, type Loader } from "./batch";

export type Row = Record<string, unknown>;

// Guard table/column names (identifiers can't be parameterized). Values always
// go through bound `?` placeholders, so they are injection-safe by construction.
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return name;
}

export class Table<T extends Row = Row> {
  constructor(
    private readonly db: JuneDb,
    private readonly name: string,
    // Per-request ambient-loader registry, shared across the juno() handle's
    // .table() calls so concurrent findBy coalesce. Optional/defaulted so a
    // standalone `new Table(db, name)` still works (it just batches alone).
    private readonly loaders: Map<string, Loader<string | number, Row>> = new Map(),
  ) {}

  async all(): Promise<T[]> {
    recordTableRead(this.name); // auto-tag: a cache() around this gets table:<name>
    return this.db.query<T>(`select * from ${ident(this.name)}`);
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
    const cols = keys.map(ident);
    const clause = cols.length ? ` where ${cols.map((k) => `${k} = ?`).join(" and ")}` : "";
    return this.db.get<T>(`select * from ${ident(this.name)}${clause} limit 1`, Object.values(where));
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

  async insert(values: Partial<T>): Promise<RunResult> {
    recordTableWrite(this.name); // auto-invalidate: invokeAction drops table:<name>
    const cols = Object.keys(values).map(ident);
    const placeholders = cols.map(() => "?").join(", ");
    return this.db.run(
      `insert into ${ident(this.name)} (${cols.join(", ")}) values (${placeholders})`,
      Object.values(values),
    );
  }

  async update(where: Partial<T>, values: Partial<T>): Promise<RunResult> {
    recordTableWrite(this.name);
    const set = Object.keys(values).map((k) => `${ident(k)} = ?`).join(", ");
    const cond = Object.keys(where).map((k) => `${ident(k)} = ?`).join(" and ");
    return this.db.run(
      `update ${ident(this.name)} set ${set} where ${cond}`,
      [...Object.values(values), ...Object.values(where)],
    );
  }

  async delete(where: Partial<T>): Promise<RunResult> {
    recordTableWrite(this.name);
    const cond = Object.keys(where).map((k) => `${ident(k)} = ?`).join(" and ");
    return this.db.run(`delete from ${ident(this.name)} where ${cond}`, Object.values(where));
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
  db: JuneDb;
};

// Wrap any JuneDb handle (ctx.db) in Juno's ergonomic surface. Build ONE per
// request: the ambient-loader registry it carries is what makes concurrent
// findBy across components coalesce — and scoping it to the per-request handle
// is what keeps keys from leaking across requests.
export function juno(db: JuneDb): Juno {
  const loaders = new Map<string, Loader<string | number, Row>>();
  return {
    db,
    table<T extends Row = Row>(name: string) {
      return new Table<T>(db, name, loaders);
    },
  };
}
