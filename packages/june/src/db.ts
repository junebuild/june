// `db` resource adapters — implementations of the @junejs/core JuneDb contract.
// Declared in june.config.ts (`resources.db: sqlite(...)` / `d1(...)`), opened
// by the host, injected onto RouteContext as `ctx.db`. The framework depends on
// the JuneDb contract; these adapters (and Juno on top) are swappable.

import type { DbFactory, JuneDb, RunResult } from "@junejs/core/resources";

import { host } from "./host";

// Local SQLite — the zero-config dev default (embedded file or :memory:). Built
// on the demoted host.openDb primitive (the sync bun:/node: driver wrapped async).
export function sqlite(opts: { path?: string } = {}): DbFactory {
  const path = opts.path ?? ":memory:";
  return { kind: "sqlite", open: () => host.openDb(path) };
}

// --- D1 (Cloudflare) — the third openDb impl (rebuild-plan Phase 5) ----------
// The binding comes from the worker's env at request time, so d1() takes the
// already-bound D1Database. Adapts D1's prepare().bind().all()/first()/run() to
// the JuneDb contract.

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

export function d1(binding: D1Database): DbFactory {
  const db: JuneDb = {
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
