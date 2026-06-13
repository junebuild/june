// The request scope — how `db` / `kv` / `blob` reach code WITHOUT riding on ctx.
//
// ctx is IDENTITY (who is calling: user, session, url, params) — what
// authorization needs. Resources are CAPABILITY (what tools exist). Mixing them
// onto one object forced every model/repo/helper to thread ctx just to touch the
// db (the Express `req.db` anti-pattern). Instead the pipeline runs each request
// inside a scope holding the opened resources, and `db`/`kv`/`blob` are ambient
// accessors that read it — so domain code never sees the request object:
//
//   import { db } from "@junejs/server";
//   const getUser = (id) => db.get("select * from users where id = ?", [id]);
//
// The async context is AsyncLocalStorage, loaded LAZILY through a non-literal
// specifier (the same trick instrumentation.ts uses) so no bundler resolves a
// static `node:*` import — workerd registers worker chunks raw and a static
// node: import breaks module registration (rebuild-plan reminders #1, #4).
// workerd provides node:async_hooks at runtime via nodejs_compat; dev gets it
// from Bun/Node. The store propagates across awaits AND to async work spawned
// inside runInScope, so a streamed loader still sees the db after fetch returns.

import type { Resources, JuneDb, JuneKv, JuneBlob } from "@junejs/core/resources";

export type RequestScope = { resources: Resources };

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

// The ambient resources. `import { db } from "@junejs/server"` anywhere.
export const db: JuneDb = ambient<JuneDb>("db");
export const kv: JuneKv = ambient<JuneKv>("kv");
export const blob: JuneBlob = ambient<JuneBlob>("blob");
