// The dialect compiler — walks an operation-node AST (ast.ts) into a SQL string.
// A `Dialect` is the seam multi-dialect lands on: subclasses override placeholder
// style / identifier quoting. SqliteDialect (sqlite + D1, bare `?`) is the default;
// PostgresDialect (`$n` placeholders, double-quoted identifiers) is the sibling. Both
// share the upsert / limit / returning syntax — only the two dialect bits differ.
//
// Compile-once: `compile()` memoizes by the node's structural key. Nodes hold
// shape only (no parameter values), so the same query shape compiles ONCE and
// every later call reuses the string — what Kysely-style builders don't do (they
// recompile per execute). Param VALUES are bound by the caller, never cached.

import type { CmpOp, Node, Predicate } from "./ast";

const SYM: Record<CmpOp, string> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
};

// Emit one WHERE predicate. `ph()` yields the next placeholder (and advances the
// dialect's counter), so `in` can consume `arity` of them in order. `q()` is the
// dialect's identifier quoter (bare on sqlite, double-quoted on Postgres).
function predicate(p: Predicate, ph: () => string, q: (name: string) => string): string {
  if (p.op === "in") {
    return `${q(p.col)} in (${Array.from({ length: p.arity }, ph).join(", ")})`;
  }
  return `${q(p.col)} ${SYM[p.op]} ${ph()}`;
}

// Guard table/column names — identifiers can't be parameterized. Values always go
// through bound placeholders, so they are injection-safe by construction.
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return name;
}

// A compact structural key: kind + table + column/clause shape. Excludes values
// (nodes carry none), so structurally-equal queries share one compiled string.
function keyOf(node: Node): string {
  switch (node.kind) {
    case "select":
      return (
        `s|${node.from}|` +
        node.where.map((p) => (p.op === "in" ? `${p.col}:in${p.arity}` : `${p.col}:${p.op}`)).join("&") +
        `|${(node.orderBy ?? []).map((o) => `${o.col} ${o.dir}`).join(",")}` +
        `|${node.limit ?? ""}|${node.offset ?? ""}`
      );
    case "insert":
      return `i|${node.into}|${node.columns.join(",")}`;
    case "update":
      return `u|${node.table}|${node.set.join(",")}|${node.where.join(",")}`;
    case "delete":
      return `d|${node.from}|${node.where.join(",")}`;
    case "upsert":
      return `x|${node.into}|${node.columns.join(",")}|${node.conflict.join(",")}|${node.update.join(",")}`;
  }
}

export abstract class Dialect {
  // Process-level (a SqliteDialect singleton is shared across requests): the
  // compiled SQL is data-free, so caching it across requests is safe and is the
  // whole point of compile-once.
  private readonly cache = new Map<string, string>();

  compile(node: Node): string {
    const key = keyOf(node);
    let sql = this.cache.get(key);
    if (sql === undefined) {
      sql = this.emit(node); // throws on a bad identifier before caching
      this.cache.set(key, sql);
    }
    return sql;
  }

  // The i-th bound placeholder (1-based). Sqlite ignores i (`?`); Postgres uses `$i`.
  protected abstract placeholder(i: number): string;

  // Identifier emission — validated, then quoted per dialect. Sqlite emits bare
  // (`col`); Postgres double-quotes (`"col"`) so reserved words (user, order) and
  // exact case survive. Overridable so the seam covers quoting, not just placeholders.
  protected quoteId(name: string): string {
    return ident(name);
  }

  protected emit(node: Node): string {
    const q = (name: string) => this.quoteId(name);
    switch (node.kind) {
      case "select": {
        let i = 0;
        const ph = () => this.placeholder(++i);
        const where = node.where.length
          ? ` where ${node.where.map((p) => predicate(p, ph, q)).join(" and ")}`
          : "";
        const order = node.orderBy?.length
          ? ` order by ${node.orderBy.map((o) => `${q(o.col)} ${o.dir === "desc" ? "desc" : "asc"}`).join(", ")}`
          : "";
        const limit = node.limit === "param" ? ` limit ${ph()}` : node.limit != null ? ` limit ${node.limit}` : "";
        const offset = node.offset === "param" ? ` offset ${ph()}` : "";
        return `select * from ${q(node.from)}${where}${order}${limit}${offset}`;
      }
      case "insert": {
        let i = 0;
        const cols = node.columns.map(q);
        const vals = node.columns.map(() => this.placeholder(++i));
        return `insert into ${q(node.into)} (${cols.join(", ")}) values (${vals.join(", ")})`;
      }
      case "update": {
        let i = 0;
        const set = node.set.map((c) => `${q(c)} = ${this.placeholder(++i)}`).join(", ");
        const where = node.where.map((c) => `${q(c)} = ${this.placeholder(++i)}`).join(" and ");
        return `update ${q(node.table)} set ${set} where ${where}`;
      }
      case "delete": {
        let i = 0;
        const where = node.where.map((c) => `${q(c)} = ${this.placeholder(++i)}`).join(" and ");
        return `delete from ${q(node.from)} where ${where}`;
      }
      case "upsert": {
        let i = 0;
        const cols = node.columns.map(q);
        const vals = node.columns.map(() => this.placeholder(++i));
        const set = node.update.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
        return (
          `insert into ${q(node.into)} (${cols.join(", ")}) values (${vals.join(", ")}) ` +
          `on conflict (${node.conflict.map(q).join(", ")}) do update set ${set} returning *`
        );
      }
    }
  }
}

export class SqliteDialect extends Dialect {
  protected placeholder(): string {
    return "?";
  }
}

// Postgres: numbered `$n` placeholders and double-quoted identifiers (so a column
// named `user`/`order`, or any non-lowercase name, is emitted correctly). Same AST,
// same upsert/limit/returning syntax — only the two dialect-specific bits differ.
export class PostgresDialect extends Dialect {
  protected placeholder(i: number): string {
    return `$${i}`;
  }
  protected override quoteId(name: string): string {
    return `"${ident(name)}"`;
  }
}

// Shared singletons so each dialect's compile-once cache is process-level. `sqlite`
// (sqlite + D1) is Juno's default; `postgres` compiles the same nodes for PG.
export const sqlite = new SqliteDialect();
export const postgres = new PostgresDialect();
