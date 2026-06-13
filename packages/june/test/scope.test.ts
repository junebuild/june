// The request scope — ambient db/kv/blob, decoupled from ctx. Resources resolve
// from the AsyncLocalStorage scope the pipeline establishes per request; using
// them outside a scope, or undeclared, throws actionable guidance.
import { describe, expect, test, beforeAll } from "bun:test";

import { db, kv, runInScope, ensureScope } from "../src/scope";
import type { JuneDb } from "@junejs/core/resources";

beforeAll(async () => {
  await ensureScope(); // wire the async-context provider (the pipeline does this per request)
});

const fakeDb = {
  query: async (sql: string, params: unknown[] = []) => [{ sql, params }],
  get: async () => ({ ok: 1 }),
  run: async () => ({ changes: 1, lastInsertRowid: 1 }),
  exec: async () => {},
  transaction: async (fn: (tx: JuneDb) => unknown) => fn(fakeDb as unknown as JuneDb),
  close: async () => {},
} as unknown as JuneDb;

describe("ambient resources", () => {
  test("inside a scope, ambient db forwards to the scoped handle", async () => {
    const rows = await runInScope({ resources: { db: fakeDb } }, () =>
      db.query("select 1", [7]),
    );
    expect(rows).toEqual([{ sql: "select 1", params: [7] }]);
  });

  test("used OUTSIDE any scope → throws guidance (not a vague TypeError)", () => {
    expect(() => db.query("select 1")).toThrow(/outside a request scope/);
  });

  test("declared resource absent in scope → throws 'no db resource' guidance", async () => {
    await runInScope({ resources: {} }, () => {
      expect(() => db.query("select 1")).toThrow(/no `db` resource is declared/);
    });
  });

  test("a different ambient (kv) is independent and also guided", () => {
    expect(() => kv.get("k")).toThrow(/outside a request scope/);
  });

  test("the scope is isolated per runInScope call", async () => {
    const a = await runInScope({ resources: { db: fakeDb } }, () => db.query("A"));
    // outside again → throws, proving the store didn't leak past the call
    expect(() => db.query("B")).toThrow(/outside a request scope/);
    expect(a).toEqual([{ sql: "A", params: [] }]);
  });
});
