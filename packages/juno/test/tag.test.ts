// The SQL table-name parser behind raw-query auto-tagging. Heuristic, so the
// contract is: cover the common shapes precisely, and over-tag (never under-tag)
// on ambiguity — under-tagging is the silent-staleness failure we must not have.

import { describe, expect, test } from "bun:test";
import { tablesFromSql, taggingDb } from "../src/tag";
import type { JuneDb } from "@junejs/core/resources";

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

describe("taggingDb forwards every method (Proxy, not spread)", () => {
  function fakeDb(calls: string[]) {
    return {
      query: async (sql: string) => (calls.push(`query:${sql}`), [] as unknown[]),
      get: async () => undefined,
      run: async () => ({ changes: 0, lastInsertRowid: 0 }),
      exec: async () => void calls.push("exec"),
      transaction: async (fn: (tx: unknown) => unknown) => fn({}),
      close: async () => void calls.push("close"),
    } as unknown as JuneDb;
  }

  test("over a plain object: all methods present; exec forwards", async () => {
    const calls: string[] = [];
    const d = taggingDb(fakeDb(calls));
    expect(typeof d.exec).toBe("function");
    expect(typeof d.transaction).toBe("function");
    await d.exec("x");
    expect(calls).toContain("exec");
  });

  test("over a Proxy (the ambient `db` shape): exec/transaction/close SURVIVE", async () => {
    const calls: string[] = [];
    const inner = fakeDb(calls);
    // an ambient-like Proxy: methods come from a get-trap, no own keys to spread
    const proxy = new Proxy({} as JuneDb, { get: (_t, p) => (inner as unknown as Record<string | symbol, unknown>)[p] });
    const d = taggingDb(proxy);
    expect(typeof d.query).toBe("function");
    expect(typeof d.exec).toBe("function"); // was `undefined` before the Proxy fix
    expect(typeof d.transaction).toBe("function");
    expect(typeof d.close).toBe("function");
    await d.exec("y");
    expect(calls).toContain("exec");
  });
});
