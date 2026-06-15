// Live end-to-end — the FULL path: juno's `table()` → dialectFor → the real
// postgres()/mysql() adapter → a live server. Skipped by default; set a connection
// string to enable:
//
//   JUNO_LIVE_PG="postgres://user:pass@host:port/db"   bun test live
//   JUNO_LIVE_MYSQL="mysql://user:pass@host:port/db"    bun test live
//
// Verified against PostgreSQL 16 + MySQL 8 (via `dew up --with postgres` / a
// host-network mysql container). The drivers (pg, mysql2) are devDependencies, loaded
// only when the adapter opens (i.e. only when the env var is set).

import { describe, expect, test } from "bun:test";
import { postgres, mysql as mysqlResource } from "@junejs/server";
import type { JuneDb } from "@junejs/core/resources";

import { juno } from "../src";

const PG_URL = process.env.JUNO_LIVE_PG;
const MY_URL = process.env.JUNO_LIVE_MYSQL;

type Person = { id: number; name: string; age: number; email: string };

// The shared CRUD matrix, run through table() over whatever live db is given.
async function runMatrix(db: JuneDb, ddl: string, expectUpsertRow: boolean) {
  const t = juno(db).table<Person>("juno_live");
  await db.exec("drop table if exists juno_live");
  await db.exec(ddl);

  await t.insert({ name: "Ada", age: 36, email: "a@x" });
  await t.insert({ name: "Linus", age: 54, email: "l@x" });
  await t.insert({ name: "Grace", age: 85, email: "g@x" });

  expect((await t.all({ age: { gt: 40 } }, { orderBy: { age: "desc" } })).map((r) => r.name)).toEqual(["Grace", "Linus"]);
  expect(await t.all({ name: { in: ["Ada", "Grace"] } })).toHaveLength(2);

  const up = await t.upsert({ name: "Ada Lovelace", age: 37, email: "a@x" }, { onConflict: "email" });
  if (expectUpsertRow) expect(up?.name).toBe("Ada Lovelace"); // PG RETURNING
  const ada = await t.findBy({ email: "a@x" }); // MySQL has no RETURNING → verify by read
  expect(ada?.name).toBe("Ada Lovelace");
  expect(ada?.age).toBe(37);

  await t.update({ email: "l@x" }, { age: 99 });
  expect((await t.findBy({ email: "l@x" }))?.age).toBe(99);

  await t.delete({ email: "g@x" });
  expect(await t.all()).toHaveLength(2);
}

(PG_URL ? describe : describe.skip)("live: PostgreSQL — table() through postgres() adapter", () => {
  test("CRUD + operators + upsert(RETURNING) end to end", async () => {
    const db = await postgres({ url: PG_URL as string }).open();
    try {
      await runMatrix(db, "create table juno_live (id serial primary key, name text not null, age int, email text unique)", true);
    } finally {
      await db.exec("drop table if exists juno_live").catch(() => {});
      await db.close();
    }
  });
});

(MY_URL ? describe : describe.skip)("live: MySQL — table() through mysql() adapter", () => {
  test("CRUD + operators + upsert(ON DUPLICATE KEY, verified by read) end to end", async () => {
    const db = await mysqlResource({ url: MY_URL as string }).open();
    try {
      await runMatrix(db, "create table juno_live (id int auto_increment primary key, name varchar(64) not null, age int, email varchar(128) unique)", false);
    } finally {
      await db.exec("drop table if exists juno_live").catch(() => {});
      await db.close();
    }
  });
});
