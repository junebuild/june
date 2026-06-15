// Postgres `db` adapter — implements the @junejs/core JuneDb contract over
// node-postgres (`pg`). Tags itself `dialect: "postgres"` so Juno compiles `$n` /
// double-quoted SQL for it (see @junejs/juno's dialectFor). `pg` is dynamically
// imported, so it's a peer the app installs only when it declares `postgres()` — the
// host never hard-depends on it. Test/dev grade: ONE connection per open(); pooling /
// env binding / deploy adapters come in a later step.

import type { DbFactory, JuneDb, RunResult } from "@junejs/core/resources";

// The slice of `pg`'s Client we depend on — so pgJuneDb is unit-testable with a fake.
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

// Wrap a connected pg client as a JuneDb. Exported (not just the factory) so the
// mapping — rows, first-row, RunResult, transaction ordering — is testable offline.
export function pgJuneDb(client: PgClientLike): JuneDb {
  const self: JuneDb = {
    dialect: "postgres",
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return ((await client.query(sql, params)).rows[0] ?? undefined) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const r = await client.query(sql, params);
      // Postgres has no autoincrement rowid — callers use `RETURNING id`. Report the
      // affected-row count; lastInsertRowid is 0 (not meaningful on PG).
      return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
    },
    async exec(sql: string) {
      await client.query(sql); // DDL / multi-statement via the simple-query protocol
    },
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      await client.query("begin");
      try {
        const out = await fn(self); // same connection
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    },
    async close() {
      await client.end();
    },
  };
  return self;
}

// `postgres({ url })` — declared in june.config.ts; opened by the host.
export function postgres(opts: { url: string }): DbFactory {
  return {
    kind: "postgres",
    open: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import("pg")) as any;
      const Client = (mod.default ?? mod).Client;
      const client = new Client({ connectionString: opts.url });
      await client.connect();
      return pgJuneDb(client);
    },
  };
}
