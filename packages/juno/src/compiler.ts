// The dialect compiler — walks an operation-node AST (ast.ts) into a SQL string.
// A `Dialect` is the seam multi-dialect lands on: subclasses override placeholder
// style / quoting / upsert syntax. SqliteDialect (sqlite + D1) is the default; a
// PostgresDialect (`$n` placeholders) slots in later as another subclass.
//
// Compile-once: `compile()` memoizes by the node's structural key. Nodes hold
// shape only (no parameter values), so the same query shape compiles ONCE and
// every later call reuses the string — what Kysely-style builders don't do (they
// recompile per execute). Param VALUES are bound by the caller, never cached.

import type { Node } from "./ast";

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
      return `s|${node.from}|${node.where.join(",")}|${node.limit ?? ""}`;
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

  protected emit(node: Node): string {
    switch (node.kind) {
      case "select": {
        let i = 0;
        const where = node.where.length
          ? ` where ${node.where.map((c) => `${ident(c)} = ${this.placeholder(++i)}`).join(" and ")}`
          : "";
        const limit = node.limit != null ? ` limit ${node.limit}` : "";
        return `select * from ${ident(node.from)}${where}${limit}`;
      }
      case "insert": {
        let i = 0;
        const cols = node.columns.map(ident);
        const vals = node.columns.map(() => this.placeholder(++i));
        return `insert into ${ident(node.into)} (${cols.join(", ")}) values (${vals.join(", ")})`;
      }
      case "update": {
        let i = 0;
        const set = node.set.map((c) => `${ident(c)} = ${this.placeholder(++i)}`).join(", ");
        const where = node.where.map((c) => `${ident(c)} = ${this.placeholder(++i)}`).join(" and ");
        return `update ${ident(node.table)} set ${set} where ${where}`;
      }
      case "delete": {
        let i = 0;
        const where = node.where.map((c) => `${ident(c)} = ${this.placeholder(++i)}`).join(" and ");
        return `delete from ${ident(node.from)} where ${where}`;
      }
      case "upsert": {
        let i = 0;
        const cols = node.columns.map(ident);
        const vals = node.columns.map(() => this.placeholder(++i));
        const set = node.update.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ");
        return (
          `insert into ${ident(node.into)} (${cols.join(", ")}) values (${vals.join(", ")}) ` +
          `on conflict (${node.conflict.map(ident).join(", ")}) do update set ${set} returning *`
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

// The default dialect (sqlite + D1). A shared singleton so its compile-once cache
// is process-level. Postgres adds a sibling subclass later.
export const sqlite = new SqliteDialect();
