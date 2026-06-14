// Auto-batch: N concurrent by-key loads in one tick → ONE query. The mechanism
// behind the render-level auto-batch / D1 8.8× number (bench/results.json).

import { describe, expect, test } from "bun:test";
import { host } from "@junejs/server/host";
import type { JuneDb } from "@junejs/core/resources";

import { juno } from "../src";

// Wrap a JuneDb to count query() calls, so we can assert "one batched query".
function counting(db: JuneDb): { db: JuneDb; queries: () => number } {
  let queries = 0;
  return {
    queries: () => queries,
    db: {
      ...db,
      query: (sql, params) => {
        queries++;
        return db.query(sql, params);
      },
    },
  };
}

async function seed(): Promise<JuneDb> {
  const db = await host.openDb(":memory:");
  await db.exec("create table users (id integer primary key, name text)");
  for (const name of ["Ada", "Linus", "Grace", "Alan"]) {
    await db.run("insert into users (name) values (?)", [name]);
  }
  return db;
}

describe("tableLoader auto-batch", () => {
  test("many concurrent loads coalesce into a single query", async () => {
    const c = counting(await seed());
    const loader = juno(c.db).table<{ id: number; name: string }>("users").loader("id");

    const [a, b, x, y] = await Promise.all([
      loader.load(1),
      loader.load(2),
      loader.load(3),
      loader.load(2), // duplicate key — deduped, still free
    ]);

    expect(a?.name).toBe("Ada");
    expect(b?.name).toBe("Linus");
    expect(x?.name).toBe("Grace");
    expect(y?.name).toBe("Linus");
    expect(c.queries()).toBe(1); // N+1 → 1
  });

  test("a missing key resolves to null without failing the batch", async () => {
    const loader = juno(await seed()).table<{ id: number; name: string }>("users").loader("id");
    const [hit, miss] = await Promise.all([loader.load(1), loader.load(999)]);
    expect(hit?.name).toBe("Ada");
    expect(miss).toBeNull();
  });

  test("rejects unsafe identifiers", () => {
    expect(() => juno({} as JuneDb).table("users").loader("id; drop")).toThrow("unsafe SQL identifier");
  });
});

describe("ambient findBy auto-batch (no loader to manage)", () => {
  type User = { id: number; name: string };

  test("concurrent findBy on the same column coalesce into ONE query", async () => {
    const c = counting(await seed());
    const t = juno(c.db).table<User>("users");
    const [a, b, dup] = await Promise.all([
      t.findBy({ id: 1 }),
      t.findBy({ id: 2 }),
      t.findBy({ id: 1 }), // duplicate key — deduped, still free
    ]);
    expect(a?.name).toBe("Ada");
    expect(b?.name).toBe("Linus");
    expect(dup?.name).toBe("Ada");
    expect(c.queries()).toBe(1); // N+1 → 1, scattered findBy with no shared loader
  });

  test("coalesces across separate .table() calls on the same juno() handle", async () => {
    const c = counting(await seed());
    const j = juno(c.db); // one handle = one request
    const [a, b] = await Promise.all([
      j.table<User>("users").findBy({ id: 1 }),
      j.table<User>("users").findBy({ id: 3 }),
    ]);
    expect(a?.name).toBe("Ada");
    expect(b?.name).toBe("Grace");
    expect(c.queries()).toBe(1); // shared per-request registry → single batch
  });

  test("a missing row resolves to undefined", async () => {
    const t = juno(await seed()).table<User>("users");
    expect(await t.findBy({ id: 999 })).toBeUndefined();
  });

  test("read-after-write in a later tick is fresh (no cross-tick cache)", async () => {
    const t = juno(await seed()).table<User>("users");
    expect((await t.findBy({ id: 1 }))?.name).toBe("Ada");
    await t.update({ id: 1 }, { name: "Ada Lovelace" });
    expect((await t.findBy({ id: 1 }))?.name).toBe("Ada Lovelace"); // re-queried, not stale
  });

  test("multi-column findBy falls back to a direct query (still correct)", async () => {
    const t = juno(await seed()).table<User>("users");
    expect((await t.findBy({ id: 1, name: "Ada" }))?.name).toBe("Ada");
    expect(await t.findBy({ id: 1, name: "Nope" })).toBeUndefined();
  });
});

describe("filtered-list read: all(where)", () => {
  type Post = { id: number; user_id: number; title: string };

  async function seedPosts(): Promise<JuneDb> {
    const db = await host.openDb(":memory:");
    await db.exec("create table posts (id integer primary key, user_id integer, title text)");
    for (const [uid, title] of [[1, "a"], [1, "b"], [2, "c"], [1, "d"], [3, "e"]] as const) {
      await db.run("insert into posts (user_id, title) values (?, ?)", [uid, title]);
    }
    return db; // user 1 has 3 posts, user 2 has 1, user 3 has 1
  }

  test("all(where) returns ALL matching rows (a list, not one)", async () => {
    const t = juno(await seedPosts()).table<Post>("posts");
    expect((await t.all({ user_id: 1 })).map((p) => p.title).sort()).toEqual(["a", "b", "d"]);
    expect(await t.all({ user_id: 2 })).toHaveLength(1);
    expect(await t.all({ user_id: 999 })).toEqual([]);
  });

  test("all() with no filter still returns everything", async () => {
    expect(await juno(await seedPosts()).table<Post>("posts").all()).toHaveLength(5);
  });

  test("concurrent all({col}) coalesce into ONE query (list N+1 → 1)", async () => {
    const c = counting(await seedPosts());
    const t = juno(c.db).table<Post>("posts");
    const [u1, u2, u3] = await Promise.all([
      t.all({ user_id: 1 }),
      t.all({ user_id: 2 }),
      t.all({ user_id: 3 }),
    ]);
    expect(u1).toHaveLength(3);
    expect(u2).toHaveLength(1);
    expect(u3).toHaveLength(1);
    expect(c.queries()).toBe(1);
  });

  test("multi-column all(where) filters by AND (direct query)", async () => {
    const r = await juno(await seedPosts()).table<Post>("posts").all({ user_id: 1, title: "a" });
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe("a");
  });

  test("read-after-write in a later tick is fresh", async () => {
    const t = juno(await seedPosts()).table<Post>("posts");
    expect(await t.all({ user_id: 2 })).toHaveLength(1);
    await t.insert({ user_id: 2, title: "new" });
    expect(await t.all({ user_id: 2 })).toHaveLength(2); // re-queried, not stale
  });
});
