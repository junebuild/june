// The request scope — how `db` / `kv` / `blob` reach code WITHOUT riding on ctx.
//
// ctx is IDENTITY (who is calling: user, session, url, params) — what
// authorization needs. Resources are CAPABILITY (what tools exist). Mixing them
// onto one object forced every model/repo/helper to thread ctx just to touch the
// db (the Express `req.db` anti-pattern). Instead the host pipeline runs each
// request inside a scope holding the opened resources, and `db`/`kv`/`blob` are
// ambient accessors that read it — so domain code never sees the request object:
//
//   import { db } from "@junejs/db";
//   const getUser = (id) => db.get("select * from users where id = ?", [id]);
//
// This package is the ambient data seam. It is EDGE-SAFE (no static `node:*`):
// the async context is AsyncLocalStorage, loaded LAZILY through a non-literal
// specifier so no bundler resolves a static `node:*` import — workerd registers
// worker chunks raw and a static node: import breaks module registration
// (rebuild-plan reminders #1, #4). workerd provides node:async_hooks at runtime
// via nodejs_compat; dev gets it from Bun/Node. The store propagates across
// awaits AND to async work spawned inside runInScope, so a streamed loader still
// sees the db after fetch returns.

import type { Resources, JuneDb, JuneKv, JuneBlob } from "@junejs/core/resources";

// `locals` is generic per-request state for layers built ON TOP of the resources
// (e.g. Juno's batch-loader registry). This package never reads it — it just
// carries it per request so such state is STRUCTURALLY request-scoped and can't be
// stashed on a long-lived handle. Lazily created by requestLocal().
export type RequestScope = { resources: Resources; locals?: Map<symbol, unknown> };

// The minimal slice of AsyncLocalStorage we use — kept structural so this module
// never statically names the runtime.
type AsyncContext<T> = { getStore(): T | undefined; run<R>(store: T, fn: () => R): R };

let als: AsyncContext<RequestScope> | null = null;
let ensuring: Promise<void> | null = null;

// Load the async-context provider once (idempotent). Awaited by the pipeline
// before the first runInScope. Hosts without async_hooks leave `als` null — then
// runInScope is a pass-through and ambient resources throw the guidance below.
export async function ensureScope(): Promise<void> {
  if (als) return;
  ensuring ??= (async () => {
    try {
      const specifier = "node:async_hooks";
      const mod = (await import(specifier)) as {
        AsyncLocalStorage: new () => AsyncContext<RequestScope>;
      };
      als = new mod.AsyncLocalStorage();
    } catch {
      /* no async_hooks on this host — ambient resources stay unavailable */
    }
  })();
  await ensuring;
}

// Run `fn` (the whole request) with the scope active. The opened resources are
// captured at call time; the store survives this returning, so a streaming
// response that renders later still resolves the same handles.
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
  return als ? als.run(scope, fn) : fn();
}

// Per-request local state for a layer built on top of the resources, keyed by a
// symbol that layer owns. Created once per request and discarded with the scope —
// so the state is structurally request-scoped and unstashable, the property a
// long-lived handle (e.g. a module-scope `juno(db)`) can't give. Throws outside a
// scope, like the ambient resources.
export function requestLocal<T>(key: symbol, make: () => T): T {
  const store = als?.getStore();
  if (!store) {
    throw new Error(
      "June: request-scoped state was used outside a request scope. It is only " +
        "available while a request is being handled (a route loader/view or an action).",
    );
  }
  const locals = (store.locals ??= new Map<symbol, unknown>());
  if (!locals.has(key)) locals.set(key, make());
  return locals.get(key) as T;
}

function pick<K extends keyof Resources>(name: K): NonNullable<Resources[K]> {
  const store = als?.getStore();
  if (!store) {
    throw new Error(
      `June: \`${name}\` was used outside a request scope. Resources are only ` +
        `available while a request is being handled (a route loader/view or an action).`,
    );
  }
  const resource = store.resources[name];
  if (!resource) {
    throw new Error(
      `June: no \`${name}\` resource is declared. Add \`resources: { ${name}: … }\` ` +
        `to june.config.ts (e.g. \`db: sqlite()\`).`,
    );
  }
  return resource as NonNullable<Resources[K]>;
}

// Forward every property access to the CURRENT request's resource handle. Methods
// are bound so `this` stays the real handle. Accessing one with no scope, or with
// the resource undeclared, throws the guidance above instead of a vague TypeError.
function ambient<T extends object>(name: keyof Resources): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const resource = pick(name) as unknown as Record<string | symbol, unknown>;
      const value = resource[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(resource) : value;
    },
  });
}

// A Tier-3 layer (Juno) registers a tagger so the ambient `db` records the tables
// each RAW query touches — what lets a raw read inside cache() be auto-invalidated
// instead of going silently stale. @junejs/db stays generic: it only CALLS the
// registered fn, never imports it, so the dependency direction stays inward
// (juno → db, never db → juno). Absent (no Juno) → `db` is raw, untagged.
let sqlTagger: ((sql: string) => void) | null = null;
export function registerSqlTagger(tag: (sql: string) => void): void {
  sqlTagger = tag;
}

// The ambient resources. `import { db } from "@junejs/db"` anywhere. `db` is the
// ONE canonical handle (the framework re-exports it); it auto-tags raw query/get/
// run when a tagger is registered, so installing Juno upgrades it in place — no
// second `db` to choose between.
export const db: JuneDb = new Proxy({} as JuneDb, {
  get(_t, prop) {
    const handle = pick("db") as unknown as Record<string | symbol, unknown>;
    const value = handle[prop];
    if (typeof value !== "function") return value;
    const fn = (value as (...a: unknown[]) => unknown).bind(handle);
    if (sqlTagger && (prop === "query" || prop === "get" || prop === "run")) {
      return (sql: string, params?: unknown[]) => (sqlTagger!(sql), fn(sql, params));
    }
    return fn;
  },
});
export const kv: JuneKv = ambient<JuneKv>("kv");
export const blob: JuneBlob = ambient<JuneBlob>("blob");
