import { beforeEach, describe, expect, test } from "bun:test";
import { host } from "@junejs/server/host";
import { juno, type Juno } from "../src";

type User = { id: number; name: string; email: string };

let j: Juno;

beforeEach(async () => {
  const db = await host.openDb(":memory:");
  await db.exec("create table users (id integer primary key, name text, email text unique)");
  j = juno(db);
});

describe("Juno table CRUD over the JuneDb contract", () => {
  test("insert + all", async () => {
    await j.table<User>("users").insert({ name: "Ada", email: "ada@x.dev" });
    await j.table<User>("users").insert({ name: "Linus", email: "linus@x.dev" });
    const rows = await j.table<User>("users").all();
    expect(rows.map((r) => r.name)).toEqual(["Ada", "Linus"]);
  });

  test("findBy returns the matching row or undefined", async () => {
    await j.table<User>("users").insert({ name: "Ada", email: "ada@x.dev" });
    expect((await j.table<User>("users").findBy({ name: "Ada" }))?.email).toBe("ada@x.dev");
    expect(await j.table<User>("users").findBy({ name: "Nobody" })).toBeUndefined();
  });

  test("update + delete", async () => {
    const ins = await j.table<User>("users").insert({ name: "Ada", email: "ada@x.dev" });
    const id = Number(ins.lastInsertRowid);
    await j.table<User>("users").update({ id }, { name: "Ada Lovelace" });
    expect((await j.table<User>("users").findBy({ id }))?.name).toBe("Ada Lovelace");
    await j.table<User>("users").delete({ id });
    expect(await j.table<User>("users").all()).toEqual([]);
  });

  test("upsert: atomic insert-or-update on conflict, returning the row", async () => {
    const t = j.table<User>("users");
    const created = await t.upsert({ name: "Ada", email: "ada@x.dev" }, { onConflict: "email" });
    expect(created?.name).toBe("Ada");

    // same email → updates in place, returns the updated row, no duplicate
    const updated = await t.upsert({ name: "Ada Lovelace", email: "ada@x.dev" }, { onConflict: "email" });
    expect(updated?.name).toBe("Ada Lovelace");
    expect(await t.all()).toHaveLength(1);
  });

  test("upsert: every provided column is the conflict key → get-or-create (keeps existing)", async () => {
    const t = j.table<User>("users");
    await t.insert({ name: "Ada", email: "ada@x.dev" });
    const got = await t.upsert({ email: "ada@x.dev" }, { onConflict: "email" });
    expect(got?.name).toBe("Ada"); // existing row returned, not overwritten
    expect(await t.all()).toHaveLength(1);
  });

  test("rejects unsafe identifiers (values stay parameterized)", () => {
    expect(() => j.table("users; drop table users").all()).toThrow("unsafe SQL identifier");
  });
});
