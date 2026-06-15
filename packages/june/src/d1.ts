// D1 (Cloudflare) `db` adapter — the EDGE half of the db resource. It adapts
// D1's prepare().bind().all()/first()/run() to the @junejs/core JuneDb contract.
//
// PURE / EDGE-SAFE: this module has NO host imports (no node:*, no ./host), so
// the generated worker can import it (via bindWorkerResources) without dragging
// the dev server into the workerd bundle. The local sqlite() adapter — which is
// host-coupled — lives in db.ts and stays out of the worker graph. D1 *is*
// SQLite, so the same SQL and Juno tables that run on the dev file run here.

import type { DbFactory, JuneDb, RunResult } from "@junejs/core/resources";

type D1Result<T> = { results: T[] };
type D1Meta = { changes?: number; last_row_id?: number };
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: D1Meta }>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<unknown>;
}

// The binding comes from the worker's env at request time, so d1() takes the
// already-bound D1Database.
export function d1(binding: D1Database): DbFactory {
  const db: JuneDb = {
    dialect: "sqlite", // D1 *is* sqlite — same SQL, same Juno compiler
    async query<T>(sql: string, params: unknown[] = []) {
      return (await binding.prepare(sql).bind(...params).all<T>()).results;
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return (await binding.prepare(sql).bind(...params).first<T>()) ?? undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const { meta } = await binding.prepare(sql).bind(...params).run();
      return { changes: meta.changes ?? 0, lastInsertRowid: meta.last_row_id ?? 0 };
    },
    async exec(sql: string) {
      await binding.exec(sql);
    },
    // D1 has no INTERACTIVE transactions (only batch()); run the fn inline. For
    // true atomicity, group writes through batch() at the call site. Documented
    // limitation of the edge backend — the contract stays uniform.
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      return fn(db);
    },
    async close() {
      /* the binding outlives the request; nothing to close */
    },
  };
  return { kind: "d1", open: async () => db };
}
