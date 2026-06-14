// The ambient surface — `table()` over June's ambient `db` resource, with its
// batch-loader registry living in the request scope (not on a handle). Proves the
// structural request-scoping: batching coalesces WITHIN a scope and a fresh scope
// gets fresh loaders, so the cross-request leak A3 found can't happen.

import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, describe, expect, test } from "bun:test";
import { ensureScope, runInScope, db as canonicalDb } from "@junejs/db";
import { host } from "@junejs/server/host";
import type { JuneDb } from "@junejs/core/resources";
import { installTraceContext, runWithTrace, type RequestTrace } from "@junejs/core/instrumentation";

import { table, installDataLayer, junoDataLayer } from "../src";

installTraceContext(new AsyncLocalStorage<RequestTrace>());

beforeAll(async () => {
  await ensureScope(); // wire AsyncLocalStorage (bun provides node:async_hooks)
  installDataLayer(); // what the host calls at boot when dataLayer: junoDataLayer()
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

describe("canonical `db` auto-tags once Juno is imported (registered tagger)", () => {
  test("forwards to the scoped handle, exec/transaction intact", async () => {
    const seeded = await seed();
    await runInScope({ resources: { db: seeded } }, async () => {
      const rows = await canonicalDb.query<{ id: number }>("select id from users where id = ?", [1]);
      expect(rows).toHaveLength(1);
      expect(typeof canonicalDb.exec).toBe("function");
      await canonicalDb.exec("create table t (id integer)");
      expect(typeof canonicalDb.transaction).toBe("function");
    });
  });

  test("auto-tags raw queries — records the read for cache invalidation", async () => {
    const seeded = await seed();
    const trace: RequestTrace = { id: "amb", startedAt: 0, events: [] };
    await runInScope({ resources: { db: seeded } }, () =>
      runWithTrace(trace, () => canonicalDb.query("select id from users")),
    );
    expect([...(trace.reads ?? [])]).toContain("users"); // tagged once the data layer is installed
  });

  test("junoDataLayer() declares the boot wiring (install + module for the build)", () => {
    const dl = junoDataLayer();
    expect(typeof dl.install).toBe("function");
    expect(dl.module).toBe("@junejs/juno"); // `june build` imports installDataLayer from here
  });
});
