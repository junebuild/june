// The request scope — ambient db/kv/blob, decoupled from ctx. Resources resolve
// from the AsyncLocalStorage scope the pipeline establishes per request; using
// them outside a scope, or undeclared, throws actionable guidance.
import { describe, expect, test, beforeAll } from "bun:test";

import { db, kv, runInScope, ensureScope, requestLocal, isolateLocal, registerSqlTagger } from "../src/scope";
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

describe("requestLocal — generic per-request state (Juno's loader registry rides here)", () => {
  const KEY = Symbol("test.local");

  test("created once per scope; same key returns the same instance", async () => {
    await runInScope({ resources: {} }, () => {
      let made = 0;
      const a = requestLocal(KEY, () => (made++, new Map<string, number>()));
      const b = requestLocal(KEY, () => (made++, new Map<string, number>()));
      expect(a).toBe(b); // cached within the request
      expect(made).toBe(1); // factory ran once
      a.set("x", 1);
      expect(requestLocal<Map<string, number>>(KEY, () => new Map()).get("x")).toBe(1);
    });
  });

  test("a separate scope gets a FRESH instance (structurally per-request)", async () => {
    const first = await runInScope({ resources: {} }, () => requestLocal(KEY, () => new Map<string, number>()));
    const second = await runInScope({ resources: {} }, () => requestLocal(KEY, () => new Map<string, number>()));
    expect(first).not.toBe(second); // no leak across requests
  });

  test("used outside a scope → throws the same guidance as ambient resources", () => {
    expect(() => requestLocal(KEY, () => new Map())).toThrow(/outside a request scope/);
  });
});

// Last — registering a tagger is a process-global; keep it after the raw tests.
describe("registerSqlTagger — a Tier-3 layer (Juno) makes the canonical db auto-tag", () => {
  test("with a tagger registered, db.query calls it first, then still forwards", async () => {
    const tagged: string[] = [];
    registerSqlTagger((sql) => tagged.push(sql));
    const rows = await runInScope({ resources: { db: fakeDb } }, () => db.query("select * from posts", [1]));
    expect(tagged).toEqual(["select * from posts"]); // tagger saw the SQL
    expect(rows).toEqual([{ sql: "select * from posts", params: [1] }]); // and the query forwarded
  });
});

// ── isolateLocal — the sibling of requestLocal, for state that must OUTLIVE a
// request. June resolves ChannelFactories and the services provider per request
// (a Worker has no env at module top-level), so a cache built there is rebuilt
// per request and never hits; this is where such a cache actually lives.
describe("isolateLocal — state that outlives the request", () => {
  test("makes once per key and returns the same value on every later call", () => {
    let made = 0;
    const make = () => (made++, new Map<string, number>());

    const a = isolateLocal("test.tokens", make);
    const b = isolateLocal("test.tokens", make);

    expect(a).toBe(b);
    expect(made).toBe(1);
    a.set("k", 1);
    expect(isolateLocal("test.tokens", make).get("k")).toBe(1);
  });

  test("survives request scopes — the point of the primitive", async () => {
    const make = () => new Map<string, number>();
    // Two separate requests write to and read from the same value.
    runInScope({ resources: {} }, () => isolateLocal("test.cross", make).set("hits", 1));
    const seen = runInScope({ resources: {} }, () => isolateLocal("test.cross", make).get("hits"));
    expect(seen).toBe(1);
    // And it resolves OUTSIDE any scope too (unlike requestLocal, which throws).
    expect(isolateLocal("test.cross", make).get("hits")).toBe(1);
  });

  test("distinct keys are distinct values; symbols work as keys", () => {
    const one = isolateLocal("test.a", () => ({ id: "a" }));
    const two = isolateLocal("test.b", () => ({ id: "b" }));
    expect(one).not.toBe(two);

    const KEY = Symbol("test.sym");
    const viaSymbol = isolateLocal(KEY, () => ({ id: "sym" }));
    expect(isolateLocal(KEY, () => ({ id: "other" }))).toBe(viaSymbol);
  });

  test("shares one registry across module instances (globalThis-keyed)", async () => {
    // A workspace symlink can give the app and the framework different copies of
    // this module; a plain module-level Map would then split in two. Re-importing
    // with a cache-busting query simulates that second instance.
    const fresh = (await import(`../src/scope?dup=${Date.now()}`)) as {
      isolateLocal: typeof isolateLocal;
    };
    const mine = isolateLocal("test.shared", () => ({ from: "first" }));
    expect(fresh.isolateLocal("test.shared", () => ({ from: "second" }))).toBe(mine);
  });
});
