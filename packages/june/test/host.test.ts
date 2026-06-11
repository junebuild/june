import { describe, expect, test } from "bun:test";
import { host } from "../src/host";

// The async-first db surface — exercised against the detected host's SQLite
// driver (bun:sqlite under `bun test`). The whole point of the redesign is that
// every call is awaited, so D1 slots in behind the same interface in Phase 5.
describe(`host.openDb() — async surface on the ${host.name} host`, () => {
  test("exec / run / query / get round-trip", async () => {
    const db = await host.openDb(":memory:");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    const ins = await db.run("INSERT INTO t (name) VALUES (?)", ["Ada"]);
    expect(ins.changes).toBe(1);
    expect(Number(ins.lastInsertRowid)).toBe(1);

    expect(await db.query("SELECT * FROM t")).toEqual([{ id: 1, name: "Ada" }]);
    expect(await db.get<{ name: string }>("SELECT name FROM t WHERE id = ?", [1])).toEqual({ name: "Ada" });
    expect(await db.get<{ name: string }>("SELECT name FROM t WHERE id = ?", [99])).toBeUndefined();

    await db.close();
  });

  test("transaction commits on success and rolls back on throw", async () => {
    const db = await host.openDb(":memory:");
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t (name) VALUES (?)", ["committed"]);
    });
    expect((await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM t"))[0]!.c).toBe(1);

    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t (name) VALUES (?)", ["rolled-back"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM t"))[0]!.c).toBe(1);

    await db.close();
  });
});
