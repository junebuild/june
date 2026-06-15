// MySQL `db` adapter — implements the @junejs/core JuneDb contract over `mysql2`.
// Tags itself `dialect: "mysql"` so Juno compiles backtick / `?` / ON DUPLICATE KEY
// SQL for it. `mysql2` is dynamically imported (a peer the app installs only when it
// declares `mysql()`). Test/dev grade: ONE connection per open(); pooling / env
// binding come later.

import type { DbFactory, JuneDb, RunResult } from "@junejs/core/resources";

// mysql2 returns [rows, fields]; a write yields a ResultSetHeader as the first element.
interface OkHeader {
  affectedRows?: number;
  insertId?: number;
}
// The slice of mysql2/promise's Connection we depend on — so mysqlJuneDb is fakeable.
export interface MysqlConnLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

// Wrap a mysql2 connection as a JuneDb. Exported for offline unit tests.
export function mysqlJuneDb(conn: MysqlConnLike): JuneDb {
  const self: JuneDb = {
    dialect: "mysql",
    async query<T>(sql: string, params: unknown[] = []) {
      return (await conn.query(sql, params))[0] as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const rows = (await conn.query(sql, params))[0] as unknown[];
      return (rows[0] ?? undefined) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const header = (await conn.query(sql, params))[0] as OkHeader;
      return { changes: header.affectedRows ?? 0, lastInsertRowid: header.insertId ?? 0 };
    },
    async exec(sql: string) {
      await conn.query(sql); // needs multipleStatements for a multi-statement script
    },
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      await conn.query("begin");
      try {
        const out = await fn(self);
        await conn.query("commit");
        return out;
      } catch (e) {
        await conn.query("rollback");
        throw e;
      }
    },
    async close() {
      await conn.end();
    },
  };
  return self;
}

// `mysql({ url })` — multipleStatements is on so exec() can run a whole migration file.
export function mysql(opts: { url: string }): DbFactory {
  return {
    kind: "mysql",
    open: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import("mysql2/promise")) as any;
      const create = (mod.default ?? mod).createConnection;
      const conn = await create({ uri: opts.url, multipleStatements: true });
      return mysqlJuneDb(conn);
    },
  };
}
