// Migrations: ordered apply, idempotent ledger, and the destructive gate (dev
// auto-applies safe; data-loss stops for explicit consent).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, readMigrations, appliedIds, migrate } from "../src/migrate";
import { host } from "../src/host";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "june-migrate-"));
  const md = join(dir, "migrations");
  await mkdir(md, { recursive: true });
  for (const [name, sql] of Object.entries(files)) await writeFile(join(md, name), sql);
  return md;
}

describe("classify (destructive DDL detector)", () => {
  test("additive DDL is safe", () => {
    expect(classify("create table users (id integer primary key, name text)").destructive).toBe(false);
    expect(classify("alter table users add column email text").destructive).toBe(false);
    expect(classify("create index idx on users(name); insert into users (name) values ('Ada')").destructive).toBe(false);
  });

  test("data-loss verbs are flagged with reasons", () => {
    expect(classify("drop table users").reasons).toEqual(["DROP TABLE"]);
    expect(classify("delete from users where id = 1").reasons).toEqual(["DELETE"]);
    expect(classify("alter table users drop column email").reasons).toContain("ALTER TABLE … DROP");
    expect(classify("alter table users rename to people").reasons).toContain("ALTER TABLE … RENAME");
  });

  test("a 'drop' inside a comment doesn't false-positive", () => {
    expect(classify("-- this will drop nothing\ncreate table t (id integer)").destructive).toBe(false);
  });
});

describe("migrate (apply + ledger + gate)", () => {
  test("applies pending in order, records the ledger, and is idempotent", async () => {
    const md = await fixture({
      "0001_users.sql": "create table users (id integer primary key, name text)",
      "0002_seed.sql": "insert into users (name) values ('Ada'), ('Grace')",
    });
    const db = await host.openDb(":memory:");

    const first = await migrate(db, md, { now: "T0" });
    expect(first.applied).toEqual(["0001_users.sql", "0002_seed.sql"]);
    expect(first.blocked).toBeNull();
    expect(await db.query("select name from users order by id")).toEqual([{ name: "Ada" }, { name: "Grace" }]);
    expect([...(await appliedIds(db))].sort()).toEqual(["0001_users.sql", "0002_seed.sql"]);

    // Re-run → nothing pending, no double-apply.
    const second = await migrate(db, md, { now: "T1" });
    expect(second.applied).toEqual([]);
    expect(await db.query<{ c: number }>("select count(*) c from users")).toEqual([{ c: 2 }]);
    await db.close();
  });

  test("destructive migration STOPS (safe prefix applied, destructive returned)", async () => {
    const md = await fixture({
      "0001_users.sql": "create table users (id integer primary key, name text, email text)",
      "0002_drop_email.sql": "alter table users drop column email",
      "0003_more.sql": "create table notes (id integer primary key)",
    });
    const db = await host.openDb(":memory:");

    const r = await migrate(db, md); // dev default: no allowDestructive
    expect(r.applied).toEqual(["0001_users.sql"]); // safe prefix only
    expect(r.blocked?.id).toBe("0002_drop_email.sql");
    expect(r.blocked?.reasons).toContain("ALTER TABLE … DROP");
    // 0003 did NOT leak ahead of the blocked one (order preserved).
    const tables = await db.query<{ name: string }>("select name from sqlite_master where type='table' and name='notes'");
    expect(tables).toEqual([]);
    await db.close();
  });

  test("allowDestructive applies through the data-loss migration", async () => {
    const md = await fixture({
      "0001_users.sql": "create table users (id integer primary key, email text)",
      "0002_drop_email.sql": "alter table users drop column email",
    });
    const db = await host.openDb(":memory:");
    const r = await migrate(db, md, { allowDestructive: true });
    expect(r.applied).toEqual(["0001_users.sql", "0002_drop_email.sql"]);
    expect(r.blocked).toBeNull();
    await db.close();
  });

  test("no migrations dir → no-op", async () => {
    const db = await host.openDb(":memory:");
    expect(await readMigrations(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
    expect((await migrate(db, join(tmpdir(), "does-not-exist-xyz"))).applied).toEqual([]);
    await db.close();
  });
});
