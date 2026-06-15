// Step 2+3 — the Table API and the batch loaders emit SQL for the db's dialect, off
// the same AST. A recording fake JuneDb (tagged with a dialect) captures the compiled
// SQL so we can assert placeholder style + identifier quoting per dialect, with no
// live server. (Real execution through the pg/mysql adapters is the live test.)

import { describe, expect, test } from "bun:test";
import type { JuneDb, RunResult, SqlDialect } from "@junejs/core/resources";

import { juno } from "../src";

function recordingDb(dialect?: SqlDialect): { db: JuneDb; sql: string[] } {
  const sql: string[] = [];
  const db: JuneDb = {
    ...(dialect ? { dialect } : {}),
    async query(s: string) {
      sql.push(s);
      return [];
    },
    async get(s: string) {
      sql.push(s);
      return undefined;
    },
    async run(s: string): Promise<RunResult> {
      sql.push(s);
      return { changes: 0, lastInsertRowid: 0 };
    },
    async exec(s: string) {
      sql.push(s);
    },
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      return fn(db);
    },
    async close() {},
  };
  return { db, sql };
}

const seen = (sql: string[], fragment: string) => sql.some((s) => s.includes(fragment));

describe("Table emits per the db's dialect tag", () => {
  test("postgres → $n placeholders + double-quoted identifiers", async () => {
    const r = recordingDb("postgres");
    const t = juno(r.db).table<{ id: number }>("users");
    await t.all({ id: { gt: 1 } }, { limit: 5 }); // direct compile path
    await t.insert({ id: 7 });
    await t.upsert({ id: 7 }, { onConflict: "id" });
    expect(seen(r.sql, 'select * from "users" where "id" > $1 limit $2')).toBe(true);
    expect(seen(r.sql, 'insert into "users" ("id") values ($1)')).toBe(true);
    expect(seen(r.sql, "on conflict")).toBe(true);
    expect(seen(r.sql, "returning *")).toBe(true);
  });

  test("mysql → ? placeholders + backtick identifiers + ON DUPLICATE KEY", async () => {
    const r = recordingDb("mysql");
    const t = juno(r.db).table<{ id: number }>("users");
    await t.all({ id: { gt: 1 } }, { limit: 5 });
    await t.upsert({ id: 7 }, { onConflict: "id" });
    expect(seen(r.sql, "select * from `users` where `id` > ? limit ?")).toBe(true);
    expect(seen(r.sql, "on duplicate key update")).toBe(true);
    expect(seen(r.sql, "returning")).toBe(false); // MySQL has no RETURNING
  });

  test("untagged db defaults to sqlite (bare ? — unchanged)", async () => {
    const r = recordingDb(); // no dialect
    await juno(r.db).table<{ id: number }>("users").all({ id: { gt: 1 } });
    expect(seen(r.sql, "select * from users where id > ?")).toBe(true);
  });
});

describe("batch loaders emit per the db's dialect tag", () => {
  test("the auto-batch `where col in (...)` uses the right placeholders/quoting", async () => {
    const pg = recordingDb("postgres");
    await juno(pg.db).table<{ id: number }>("users").findBy({ id: 1 }); // single-col → batched
    expect(seen(pg.sql, 'select * from "users" where "id" in ($1)')).toBe(true);

    const my = recordingDb("mysql");
    await juno(my.db).table<{ id: number; user_id: number }>("posts").all({ user_id: 7 }); // single-col → list batch
    expect(seen(my.sql, "select * from `posts` where `user_id` in (?)")).toBe(true);

    const lite = recordingDb();
    await juno(lite.db).table<{ id: number }>("users").findBy({ id: 1 });
    expect(seen(lite.sql, "select * from users where id in (?)")).toBe(true);
  });
});
