// The SQL table-name parser behind raw-query auto-tagging. Heuristic, so the
// contract is: cover the common shapes precisely, and over-tag (never under-tag)
// on ambiguity — under-tagging is the silent-staleness failure we must not have.

import { describe, expect, test } from "bun:test";
import { tablesFromSql } from "../src/tag";

describe("tablesFromSql", () => {
  test("select: single table", () => {
    expect(tablesFromSql("select * from posts where user_id = ?")).toEqual({ kind: "read", tables: ["posts"] });
  });

  test("select: joins pick up every table", () => {
    const t = tablesFromSql("SELECT * FROM orders o JOIN line_items li ON li.order_id = o.id");
    expect(t.kind).toBe("read");
    expect(t.tables.sort()).toEqual(["line_items", "orders"]);
  });

  test("insert / update / delete classify as writes with their target", () => {
    expect(tablesFromSql("insert into users (name) values (?)")).toEqual({ kind: "write", tables: ["users"] });
    expect(tablesFromSql("update users set name = ? where id = ?")).toEqual({ kind: "write", tables: ["users"] });
    expect(tablesFromSql("delete from users where id = ?")).toEqual({ kind: "write", tables: ["users"] });
  });

  test("insert ... on conflict still tags the target table", () => {
    expect(tablesFromSql("INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING")).toEqual({
      kind: "write",
      tables: ["users"],
    });
  });

  test("quoted and schema-qualified names reduce to the bare table", () => {
    expect(tablesFromSql('select * from "posts"').tables).toEqual(["posts"]);
    expect(tablesFromSql("select * from main.posts").tables).toEqual(["posts"]);
  });

  test("comments don't fool it", () => {
    expect(tablesFromSql("select * /* not_a_table */ from posts -- from decoy").tables).toEqual(["posts"]);
  });

  test("unclassifiable SQL returns no tables (→ explicit escape hatch)", () => {
    expect(tablesFromSql("pragma journal_mode = wal")).toEqual({ kind: "other", tables: [] });
    expect(tablesFromSql("select 1").tables).toEqual([]);
  });
});
