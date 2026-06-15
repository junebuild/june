// The Postgres / MySQL JuneDb adapters — mapping coverage with FAKE clients (no live
// DB, runs in normal `bun test`). Asserts dialect tag, rows / first-row / RunResult
// mapping, and transaction commit/rollback ordering. End-to-end execution against real
// servers is the skip-by-default live test in @junejs/juno (step 2+3).

import { describe, expect, test } from "bun:test";
import { pgJuneDb, type PgClientLike } from "../src/postgres-driver";
import { mysqlJuneDb, type MysqlConnLike } from "../src/mysql-driver";
import { libsqlJuneDb, turso, type LibsqlClientLike } from "../src/turso-driver";

// --- Postgres -----------------------------------------------------------------
function fakePg(rows: unknown[], rowCount: number | null) {
  const calls: string[] = [];
  const client: PgClientLike = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: /^\s*select/i.test(sql) ? rows : [], rowCount };
    },
    async end() {
      calls.push("__end__");
    },
  };
  return { calls, client };
}

describe("pgJuneDb (Postgres adapter mapping)", () => {
  test("tags dialect postgres", () => {
    expect(pgJuneDb(fakePg([], 0).client).dialect).toBe("postgres");
  });

  test("query → rows; get → first row or undefined", async () => {
    const db = pgJuneDb(fakePg([{ id: 1 }, { id: 2 }], 2).client);
    expect(await db.query<{ id: number }>("select * from t")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await db.get<{ id: number }>("select * from t")).toEqual({ id: 1 });
    const empty = pgJuneDb(fakePg([], 0).client);
    expect(await empty.get("select * from t where id = $1", [9])).toBeUndefined();
  });

  test("run → { changes: rowCount, lastInsertRowid: 0 } (PG has no rowid)", async () => {
    const db = pgJuneDb(fakePg([], 3).client);
    expect(await db.run("update t set x = $1", [1])).toEqual({ changes: 3, lastInsertRowid: 0 });
  });

  test("transaction commits on success (begin → commit), rolls back on throw", async () => {
    const ok = fakePg([], 0);
    await pgJuneDb(ok.client).transaction(async (tx) => {
      await tx.run("insert into t values ($1)", [1]);
    });
    expect(ok.calls).toEqual(["begin", "insert into t values ($1)", "commit"]);

    const bad = fakePg([], 0);
    await expect(
      pgJuneDb(bad.client).transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(bad.calls).toEqual(["begin", "rollback"]);
  });

  test("close → client.end()", async () => {
    const f = fakePg([], 0);
    await pgJuneDb(f.client).close();
    expect(f.calls).toEqual(["__end__"]);
  });
});

// --- MySQL --------------------------------------------------------------------
function fakeMy(rows: unknown[], header: { affectedRows?: number; insertId?: number }) {
  const calls: string[] = [];
  const conn: MysqlConnLike = {
    async query(sql: string): Promise<[unknown, unknown]> {
      calls.push(sql);
      return [/^\s*select/i.test(sql) ? rows : header, undefined];
    },
    async end() {
      calls.push("__end__");
    },
  };
  return { calls, conn };
}

describe("mysqlJuneDb (MySQL adapter mapping)", () => {
  test("tags dialect mysql", () => {
    expect(mysqlJuneDb(fakeMy([], {}).conn).dialect).toBe("mysql");
  });

  test("query → rows[0] of the [rows, fields] tuple; get → first row or undefined", async () => {
    const db = mysqlJuneDb(fakeMy([{ id: 1 }, { id: 2 }], {}).conn);
    expect(await db.query<{ id: number }>("select * from t")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await db.get<{ id: number }>("select * from t")).toEqual({ id: 1 });
    expect(await mysqlJuneDb(fakeMy([], {}).conn).get("select 1")).toBeUndefined();
  });

  test("run → { changes: affectedRows, lastInsertRowid: insertId }", async () => {
    const db = mysqlJuneDb(fakeMy([], { affectedRows: 2, insertId: 42 }).conn);
    expect(await db.run("insert into t (x) values (?)", [1])).toEqual({ changes: 2, lastInsertRowid: 42 });
  });

  test("transaction commits on success, rolls back on throw", async () => {
    const ok = fakeMy([], {});
    await mysqlJuneDb(ok.conn).transaction(async (tx) => {
      await tx.run("insert into t values (?)", [1]);
    });
    expect(ok.calls).toEqual(["begin", "insert into t values (?)", "commit"]);

    const bad = fakeMy([], {});
    await expect(
      mysqlJuneDb(bad.conn).transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(bad.calls).toEqual(["begin", "rollback"]);
  });

  test("close → conn.end()", async () => {
    const f = fakeMy([], {});
    await mysqlJuneDb(f.conn).close();
    expect(f.calls).toEqual(["__end__"]);
  });
});

// --- Turso / libsql -----------------------------------------------------------
function fakeLibsql(
  rows: unknown[],
  res: { rowsAffected?: number; lastInsertRowid?: bigint | number } = {},
) {
  const calls: string[] = [];
  const client: LibsqlClientLike = {
    async execute(stmt) {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      calls.push(sql);
      return {
        rows: /^\s*select/i.test(sql) ? rows : [],
        rowsAffected: res.rowsAffected ?? 0,
        lastInsertRowid: res.lastInsertRowid,
      };
    },
    async executeMultiple(sql: string) {
      calls.push(`multi:${sql}`);
    },
    close() {
      calls.push("__close__");
    },
  };
  return { calls, client };
}

describe("libsqlJuneDb (Turso adapter mapping)", () => {
  test("tags dialect sqlite (libsql IS sqlite)", () => {
    expect(libsqlJuneDb(fakeLibsql([]).client).dialect).toBe("sqlite");
  });

  test("query → rows; get → first row or undefined", async () => {
    const db = libsqlJuneDb(fakeLibsql([{ id: 1 }, { id: 2 }]).client);
    expect(await db.query<{ id: number }>("select * from t")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await db.get<{ id: number }>("select * from t")).toEqual({ id: 1 });
    expect(await libsqlJuneDb(fakeLibsql([]).client).get("select 1")).toBeUndefined();
  });

  test("run → { changes: rowsAffected, lastInsertRowid }, coercing the bigint rowid", async () => {
    const db = libsqlJuneDb(fakeLibsql([], { rowsAffected: 2, lastInsertRowid: 42n }).client);
    expect(await db.run("insert into t (x) values (?)", [1])).toEqual({ changes: 2, lastInsertRowid: 42 });
  });

  test("exec → executeMultiple (multi-statement DDL)", async () => {
    const f = fakeLibsql([]);
    await libsqlJuneDb(f.client).exec("create table a(x); create table b(y);");
    expect(f.calls).toEqual(["multi:create table a(x); create table b(y);"]);
  });

  test("transaction commits on success, rolls back on throw", async () => {
    const ok = fakeLibsql([]);
    await libsqlJuneDb(ok.client).transaction(async (tx) => {
      await tx.run("insert into t values (?)", [1]);
    });
    expect(ok.calls).toEqual(["BEGIN", "insert into t values (?)", "COMMIT"]);

    const bad = fakeLibsql([]);
    await expect(
      libsqlJuneDb(bad.client).transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(bad.calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("close → client.close()", async () => {
    const f = fakeLibsql([]);
    await libsqlJuneDb(f.client).close();
    expect(f.calls).toEqual(["__close__"]);
  });

  test("turso() fails clearly when no url is given and no env is set", async () => {
    const saved = process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_DATABASE_URL;
    try {
      await expect(turso().open()).rejects.toThrow(/no database url/);
    } finally {
      if (saved !== undefined) process.env.TURSO_DATABASE_URL = saved;
    }
  });
});
