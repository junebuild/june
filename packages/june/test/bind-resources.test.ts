// bindWorkerResources — the PROD/worker provider that binds declared resources
// to their edge handles from env (env.DB → D1). This is the runtime half of
// "sqlite dev → D1 prod"; the build half (emitting the wrangler d1 binding) lives
// in adapter.test.ts, and the dev half (local sqlite) in resources.test.ts.
import { describe, expect, test } from "bun:test";

import { bindWorkerResources } from "../src/resources";

// A minimal fake of the Cloudflare D1 binding surface bindWorkerResources adapts.
function fakeD1() {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    binding: {
      prepare(sql: string) {
        const stmt = {
          _params: [] as unknown[],
          bind(...p: unknown[]) {
            this._params = p;
            return this;
          },
          async all<T>() {
            calls.push({ sql, params: this._params });
            return { results: [{ ok: 1 } as T] };
          },
          async first<T>() {
            calls.push({ sql, params: this._params });
            return { ok: 1 } as T;
          },
          async run() {
            calls.push({ sql, params: this._params });
            return { meta: { changes: 1, last_row_id: 7 } };
          },
        };
        return stmt;
      },
      async exec() {},
    },
  };
}

describe("bindWorkerResources", () => {
  test("no flags → empty provider, ignores env", async () => {
    const provide = bindWorkerResources({});
    expect(await provide({ DB: fakeD1().binding })).toEqual({});
    expect(await provide()).toEqual({});
  });

  test("db flag + env.DB → db is the D1 binding", async () => {
    const d1 = fakeD1();
    const provide = bindWorkerResources({ db: true });
    const { db } = await provide({ DB: d1.binding });
    expect(await db!.query("select 1")).toEqual([{ ok: 1 }]);
    expect(d1.calls).toHaveLength(1);
    expect(d1.calls[0]!.sql).toBe("select 1");
  });

  test("db flag but NO env binding → db undefined (degrades, no local fs at the edge)", async () => {
    const provide = bindWorkerResources({ db: true });
    expect((await provide()).db).toBeUndefined();
    expect((await provide({})).db).toBeUndefined();
  });

  test("memoized per provider — the handle resolves once and is reused", async () => {
    const provide = bindWorkerResources({ db: true });
    const env = { DB: fakeD1().binding };
    const a = await provide(env);
    const b = await provide(env);
    expect(a).toBe(b); // same Resources object
  });
});
