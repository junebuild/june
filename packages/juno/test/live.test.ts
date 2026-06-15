// Live-dialect tests — run juno's COMPILED SQL against real Postgres / MySQL servers,
// not just string assertions. Skipped by default; set a connection string to enable:
//
//   JUNO_LIVE_PG="postgres://user:pass@host:port/db"   bun test live
//   JUNO_LIVE_MYSQL="mysql://user:pass@host:port/db"    bun test live
//
// (Each was verified against PostgreSQL 16 and MySQL 8 via an ephemeral `dew up
// --with postgres` / a host-network mysql container.) The drivers (pg, mysql2) are
// devDependencies and only imported when the matching env var is set.

import { describe, expect, test } from "bun:test";
import { postgres, mysql as mysqlDialect } from "../src/compiler";
import type { Node } from "../src/ast";

const PG_URL = process.env.JUNO_LIVE_PG;
const MY_URL = process.env.JUNO_LIVE_MYSQL;

// The shared shape matrix — built once, compiled per dialect at the call site.
const insert: Node = { kind: "insert", into: "juno_live", columns: ["name", "age", "email"] };
const selGtDesc: Node = { kind: "select", from: "juno_live", where: [{ col: "age", op: "gt" }], orderBy: [{ col: "age", dir: "desc" }] };
const selIn: Node = { kind: "select", from: "juno_live", where: [{ col: "name", op: "in", arity: 2 }], orderBy: [{ col: "id", dir: "asc" }], limit: "param", offset: "param" };
const upsert: Node = { kind: "upsert", into: "juno_live", columns: ["name", "age", "email"], conflict: ["email"], update: ["name", "age"] };
const updAge: Node = { kind: "update", table: "juno_live", set: ["age"], where: ["email"] };
const selByEmail: Node = { kind: "select", from: "juno_live", where: [{ col: "email", op: "eq" }] };
const delByEmail: Node = { kind: "delete", from: "juno_live", where: ["email"] };

(PG_URL ? describe : describe.skip)("live: PostgreSQL — juno's compiled SQL executes", () => {
  test("CRUD + operators + upsert(ON CONFLICT … RETURNING *)", async () => {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    const run = (node: Node, params: unknown[] = []) => c.query(postgres.compile(node), params);
    try {
      await c.query("drop table if exists juno_live");
      await c.query("create table juno_live (id serial primary key, name text not null, age int, email text unique)");

      await run(insert, ["Ada", 36, "a@x"]);
      await run(insert, ["Linus", 54, "l@x"]);
      await run(insert, ["Grace", 85, "g@x"]);

      const gt = await run(selGtDesc, [40]);
      expect(gt.rows.map((r) => r.name)).toEqual(["Grace", "Linus"]);

      const inq = await run(selIn, ["Ada", "Grace", 5, 0]);
      expect(inq.rows).toHaveLength(2);

      const up = await run(upsert, ["Ada Lovelace", 37, "a@x"]); // returns the updated row
      expect(up.rows[0].name).toBe("Ada Lovelace");
      expect(up.rows[0].age).toBe(37);

      await run(updAge, [99, "l@x"]);
      expect((await run(selByEmail, ["l@x"])).rows[0].age).toBe(99);

      await run(delByEmail, ["g@x"]);
      expect((await c.query("select count(*)::int n from juno_live")).rows[0].n).toBe(2);
    } finally {
      await c.query("drop table if exists juno_live").catch(() => {});
      await c.end();
    }
  });
});

(MY_URL ? describe : describe.skip)("live: MySQL — juno's compiled SQL executes", () => {
  test("CRUD + operators + upsert(ON DUPLICATE KEY UPDATE, verified by SELECT)", async () => {
    const mysql = await import("mysql2/promise");
    const c = await mysql.createConnection(MY_URL as string);
    const run = async (node: Node, params: unknown[] = []) => (await c.query(mysqlDialect.compile(node), params))[0] as any;
    try {
      await c.query("drop table if exists juno_live");
      await c.query("create table juno_live (id int auto_increment primary key, name varchar(64) not null, age int, email varchar(128) unique)");

      await run(insert, ["Ada", 36, "a@x"]);
      await run(insert, ["Linus", 54, "l@x"]);
      await run(insert, ["Grace", 85, "g@x"]);

      expect((await run(selGtDesc, [40])).map((r: any) => r.name)).toEqual(["Grace", "Linus"]);
      expect(await run(selIn, ["Ada", "Grace", 5, 0])).toHaveLength(2);

      await run(upsert, ["Ada Lovelace", 37, "a@x"]); // no RETURNING on MySQL
      const ada = (await run(selByEmail, ["a@x"]))[0];
      expect(ada.name).toBe("Ada Lovelace");
      expect(ada.age).toBe(37);

      await run(updAge, [99, "l@x"]);
      expect((await run(selByEmail, ["l@x"]))[0].age).toBe(99);

      await run(delByEmail, ["g@x"]);
      expect((await run({ kind: "select", from: "juno_live", where: [] }))).toHaveLength(2);
    } finally {
      await c.query("drop table if exists juno_live").catch(() => {});
      await c.end();
    }
  });
});
