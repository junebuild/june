// The AST → SQL compiler. Stage 1 of the query layer: the table API builds these
// nodes and compiles them once per shape. Tests cover SQL correctness per node
// kind, compile-once caching, identifier safety, and the dialect seam (a `$n`
// subclass proves multi-dialect works off the same AST before a real Postgres one).

import { describe, expect, test } from "bun:test";
import { Dialect, SqliteDialect, PostgresDialect, sqlite, postgres } from "../src/compiler";
import type { Node } from "../src/ast";

describe("SqliteDialect.compile — SQL per node kind", () => {
  test("select: none / equality where / where+limit", () => {
    expect(sqlite.compile({ kind: "select", from: "users", where: [] })).toBe("select * from users");
    expect(
      sqlite.compile({
        kind: "select",
        from: "users",
        where: [{ col: "a", op: "eq" }, { col: "b", op: "eq" }],
      }),
    ).toBe("select * from users where a = ? and b = ?");
    expect(
      sqlite.compile({ kind: "select", from: "users", where: [{ col: "id", op: "eq" }], limit: 1 }),
    ).toBe("select * from users where id = ? limit 1");
  });

  test("select: operators (gt/lte/ne/like/in), order, param limit/offset", () => {
    expect(
      sqlite.compile({
        kind: "select",
        from: "users",
        where: [{ col: "age", op: "gte" }, { col: "name", op: "like" }],
      }),
    ).toBe("select * from users where age >= ? and name like ?");
    expect(
      sqlite.compile({ kind: "select", from: "users", where: [{ col: "id", op: "in", arity: 3 }] }),
    ).toBe("select * from users where id in (?, ?, ?)");
    expect(
      sqlite.compile({
        kind: "select",
        from: "posts",
        where: [{ col: "user_id", op: "eq" }],
        orderBy: [{ col: "created_at", dir: "desc" }],
        limit: "param",
        offset: "param",
      }),
    ).toBe("select * from posts where user_id = ? order by created_at desc limit ? offset ?");
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
    const shape: Node = { kind: "select", from: "users", where: [{ col: "id", op: "eq" }], limit: 1 };
    expect(d.compile(shape)).toBe(d.compile({ ...shape })); // structurally equal → cache hit
    expect(d.emits).toBe(1);
    d.compile({ kind: "select", from: "users", where: [{ col: "name", op: "eq" }], limit: 1 }); // different shape
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
    expect(
      pg.compile({
        kind: "select",
        from: "users",
        where: [{ col: "a", op: "eq" }, { col: "b", op: "eq" }],
      }),
    ).toBe("select * from users where a = $1 and b = $2");
    expect(pg.compile({ kind: "insert", into: "t", columns: ["x", "y"] })).toBe(
      "insert into t (x, y) values ($1, $2)",
    );
    // the $n counter must run across in-elements + limit/offset, in order
    expect(
      pg.compile({
        kind: "select",
        from: "users",
        where: [{ col: "id", op: "in", arity: 2 }],
        limit: "param",
        offset: "param",
      }),
    ).toBe("select * from users where id in ($1, $2) limit $3 offset $4");
  });
});

describe("PostgresDialect — $n placeholders + quoted identifiers", () => {
  test("select: $n counter across where / in / limit / offset, identifiers quoted", () => {
    expect(
      postgres.compile({
        kind: "select",
        from: "users",
        where: [{ col: "a", op: "eq" }, { col: "b", op: "eq" }],
      }),
    ).toBe('select * from "users" where "a" = $1 and "b" = $2');
    expect(
      postgres.compile({ kind: "select", from: "users", where: [{ col: "id", op: "in", arity: 3 }] }),
    ).toBe('select * from "users" where "id" in ($1, $2, $3)');
    expect(
      postgres.compile({
        kind: "select",
        from: "posts",
        where: [{ col: "user_id", op: "gte" }],
        orderBy: [{ col: "created_at", dir: "desc" }],
        limit: "param",
        offset: "param",
      }),
    ).toBe('select * from "posts" where "user_id" >= $1 order by "created_at" desc limit $2 offset $3');
  });

  test("a non-param literal limit is inlined (not a placeholder), still quoted from", () => {
    expect(
      postgres.compile({ kind: "select", from: "users", where: [{ col: "id", op: "eq" }], limit: 1 }),
    ).toBe('select * from "users" where "id" = $1 limit 1');
  });

  test("insert / update / delete: quoted identifiers, $n in order", () => {
    expect(postgres.compile({ kind: "insert", into: "users", columns: ["name", "email"] })).toBe(
      'insert into "users" ("name", "email") values ($1, $2)',
    );
    expect(postgres.compile({ kind: "update", table: "users", set: ["name"], where: ["id"] })).toBe(
      'update "users" set "name" = $1 where "id" = $2',
    );
    expect(postgres.compile({ kind: "delete", from: "users", where: ["id"] })).toBe(
      'delete from "users" where "id" = $1',
    );
  });

  test("upsert: ON CONFLICT ... excluded ... RETURNING * with quoting", () => {
    expect(
      postgres.compile({
        kind: "upsert",
        into: "users",
        columns: ["name", "email"],
        conflict: ["email"],
        update: ["name"],
      }),
    ).toBe(
      'insert into "users" ("name", "email") values ($1, $2) ' +
        'on conflict ("email") do update set "name" = excluded."name" returning *',
    );
  });

  test("quotes a reserved word safely (the reason to quote at all)", () => {
    // `user` / `order` are Postgres reserved words — bare would be a syntax error.
    expect(
      postgres.compile({ kind: "select", from: "user", where: [{ col: "order", op: "eq" }] }),
    ).toBe('select * from "user" where "order" = $1');
  });

  test("still rejects unsafe identifiers (quoting is not an escape hatch)", () => {
    expect(() => postgres.compile({ kind: "select", from: 'x" drop', where: [] })).toThrow(
      "unsafe SQL identifier",
    );
  });

  test("the same AST yields ? for sqlite and $n for postgres (one shape, two dialects)", () => {
    const node: Node = { kind: "select", from: "users", where: [{ col: "id", op: "eq" }] };
    expect(sqlite.compile(node)).toBe("select * from users where id = ?");
    expect(postgres.compile(node)).toBe('select * from "users" where "id" = $1');
  });

  test("each dialect caches independently (compile-once is per instance)", () => {
    class CountingPg extends PostgresDialect {
      emits = 0;
      protected override emit(node: Node): string {
        this.emits++;
        return super.emit(node);
      }
    }
    const d = new CountingPg();
    const shape: Node = { kind: "select", from: "t", where: [{ col: "id", op: "eq" }] };
    expect(d.compile(shape)).toBe(d.compile({ ...shape }));
    expect(d.emits).toBe(1); // second call hit the cache
  });
});
