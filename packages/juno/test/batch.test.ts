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
