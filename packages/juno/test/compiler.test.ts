// The AST → SQL compiler. Stage 1 of the query layer: the table API builds these
// nodes and compiles them once per shape. Tests cover SQL correctness per node
// kind, compile-once caching, identifier safety, and the dialect seam (a `$n`
// subclass proves multi-dialect works off the same AST before a real Postgres one).

import { describe, expect, test } from "bun:test";
import { Dialect, SqliteDialect, sqlite } from "../src/compiler";
import type { Node } from "../src/ast";

describe("SqliteDialect.compile — SQL per node kind", () => {
  test("select: none / where / where+limit", () => {
    expect(sqlite.compile({ kind: "select", from: "users", where: [] })).toBe("select * from users");
    expect(sqlite.compile({ kind: "select", from: "users", where: ["a", "b"] })).toBe(
      "select * from users where a = ? and b = ?",
    );
    expect(sqlite.compile({ kind: "select", from: "users", where: ["id"], limit: 1 })).toBe(
      "select * from users where id = ? limit 1",
    );
  });

  test("insert / update / delete", () => {
    expect(sqlite.compile({ kind: "insert", into: "users", columns: ["name", "email"] })).toBe(
      "insert into users (name, email) values (?, ?)",
    );
    expect(sqlite.compile({ kind: "update", table: "users", set: ["name"], where: ["id"] })).toBe(
      "update users set name = ? where id = ?",
    );
    expect(sqlite.compile({ kind: "delete", from: "users", where: ["id"] })).toBe(
      "delete from users where id = ?",
    );
  });

  test("upsert: ON CONFLICT ... DO UPDATE ... RETURNING *", () => {
    expect(
      sqlite.compile({
        kind: "upsert",
        into: "users",
        columns: ["name", "email"],
        conflict: ["email"],
        update: ["name"],
      }),
    ).toBe(
      "insert into users (name, email) values (?, ?) on conflict (email) do update set name = excluded.name returning *",
    );
  });

  test("rejects unsafe identifiers (table or column)", () => {
    expect(() => sqlite.compile({ kind: "select", from: "users; drop", where: [] })).toThrow(
      "unsafe SQL identifier",
    );
    expect(() => sqlite.compile({ kind: "insert", into: "t", columns: ["a; b"] })).toThrow(
      "unsafe SQL identifier",
    );
  });
});

describe("compile-once", () => {
  class CountingSqlite extends SqliteDialect {
    emits = 0;
    protected override emit(node: Node): string {
      this.emits++;
      return super.emit(node);
    }
  }

  test("same shape compiles once; a different shape compiles again", () => {
    const d = new CountingSqlite();
    const shape: Node = { kind: "select", from: "users", where: ["id"], limit: 1 };
    expect(d.compile(shape)).toBe(d.compile({ ...shape })); // structurally equal → cache hit
    expect(d.emits).toBe(1);
    d.compile({ kind: "select", from: "users", where: ["name"], limit: 1 }); // different shape
    expect(d.emits).toBe(2);
  });
});

describe("dialect seam (multi-dialect off one AST)", () => {
  class PgDialect extends Dialect {
    protected placeholder(i: number): string {
      return `$${i}`;
    }
  }

  test("a $n placeholder subclass compiles the same nodes for Postgres", () => {
    const pg = new PgDialect();
    expect(pg.compile({ kind: "select", from: "users", where: ["a", "b"] })).toBe(
      "select * from users where a = $1 and b = $2",
    );
    expect(pg.compile({ kind: "insert", into: "t", columns: ["x", "y"] })).toBe(
      "insert into t (x, y) values ($1, $2)",
    );
  });
});
