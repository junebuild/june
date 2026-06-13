// The local-sqlite driver layer: it picks the runtime's built-in sqlite and,
// on Node too old for node:sqlite, turns the cryptic builtin-module failure into
// actionable guidance. The round-trip runs on whichever runtime hosts the suite
// (bun:sqlite or node:sqlite); the help message is unit-tested directly.
import { describe, expect, test } from "bun:test";

import {
  openLocalSqlite,
  nodeSqliteHelp,
  NODE_SQLITE_MIN_LTS,
  NODE_SQLITE_MIN_ODD,
} from "../src/sqlite-driver";

describe("openLocalSqlite", () => {
  test("opens the runtime's built-in sqlite and round-trips through JuneDb", async () => {
    const db = await openLocalSqlite(":memory:");
    await db.exec("create table t (id integer primary key, v text)");
    const r = await db.run("insert into t (v) values (?)", ["hi"]);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(await db.get<{ v: string }>("select v from t where id = ?", [1])).toEqual({ v: "hi" });
    expect(await db.query<{ v: string }>("select v from t")).toEqual([{ v: "hi" }]);
    // missing row → undefined (the bun/node null-vs-undefined seam)
    expect(await db.get<{ v: string }>("select v from t where id = ?", [999])).toBeUndefined();
    await db.close();
  });

  test("transaction commits on success and rolls back on throw", async () => {
    const db = await openLocalSqlite(":memory:");
    await db.exec("create table t (id integer primary key, v text)");
    await db.transaction(async (tx) => {
      await tx.run("insert into t (v) values (?)", ["committed"]);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.run("insert into t (v) values (?)", ["rolled-back"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select v from t")).toEqual([{ v: "committed" }]);
    await db.close();
  });
});

describe("nodeSqliteHelp (the version-cliff guidance)", () => {
  test("names the running version and both escape hatches", () => {
    const msg = nodeSqliteHelp("20.11.0");
    expect(msg).toContain("v20.11.0");
    expect(msg).toContain(NODE_SQLITE_MIN_LTS); // 22.13.0
    expect(msg).toContain(NODE_SQLITE_MIN_ODD); // 23.4.0
    expect(msg).toContain("--experimental-sqlite"); // explains the flagged middle band
    expect(msg.toLowerCase()).toContain("bun"); // the no-version-floor alternative
  });

  test("the version floor is the flag-free node:sqlite release", () => {
    expect(NODE_SQLITE_MIN_LTS).toBe("22.13.0");
    expect(NODE_SQLITE_MIN_ODD).toBe("23.4.0");
  });
});
