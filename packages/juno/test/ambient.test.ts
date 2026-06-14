// The ambient surface — `table()` over June's ambient `db` resource, with its
// batch-loader registry living in the request scope (not on a handle). Proves the
// structural request-scoping: batching coalesces WITHIN a scope and a fresh scope
// gets fresh loaders, so the cross-request leak A3 found can't happen.

import { beforeAll, describe, expect, test } from "bun:test";
import { ensureScope, runInScope } from "@junejs/db";
import { host } from "@junejs/server/host";
import type { JuneDb } from "@junejs/core/resources";

import { table } from "../src";

beforeAll(async () => {
  await ensureScope(); // wire AsyncLocalStorage (bun provides node:async_hooks)
});

function counting(db: JuneDb): { db: JuneDb; queries: () => number } {
  let queries = 0;
  return {
    queries: () => queries,
    db: { ...db, query: (sql, params) => (queries++, db.query(sql, params)) },
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

describe("ambient table — request-scoped, no handle", () => {
  test("findBy / all resolve against the ambient db inside a scope", async () => {
    const db = await seed();
    await runInScope({ resources: { db } }, async () => {
      expect((await table<{ id: number; name: string }>("users").findBy({ id: 1 }))?.name).toBe("Ada");
      expect(await table("users").all()).toHaveLength(4);
    });
  });

  test("concurrent findBy WITHIN one scope coalesce into a single query", async () => {
    const c = counting(await seed());
    await runInScope({ resources: { db: c.db } }, async () => {
      const t = () => table<{ id: number; name: string }>("users");
      const [a, b, dup] = await Promise.all([t().findBy({ id: 1 }), t().findBy({ id: 2 }), t().findBy({ id: 1 })]);
      expect(a?.name).toBe("Ada");
      expect(b?.name).toBe("Linus");
      expect(dup?.name).toBe("Ada");
      expect(c.queries()).toBe(1); // shared per-request loaders → one batch
    });
  });

  test("a separate scope gets fresh loaders — no cross-request coalescing/leak", async () => {
    const c = counting(await seed());
    await runInScope({ resources: { db: c.db } }, () => table("users").findBy({ id: 1 }));
    await runInScope({ resources: { db: c.db } }, () => table("users").findBy({ id: 2 }));
    expect(c.queries()).toBe(2); // two requests = two batches, never merged
  });

  test("throws when used outside a request scope", () => {
    expect(() => table("users")).toThrow("outside a request scope");
  });
});
