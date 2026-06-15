// Turso / libsql `db` adapter — implements the @junejs/core JuneDb contract over
// @libsql/client. Turso speaks libsql (SQLite over an HTTPS endpoint), so it tags
// itself `dialect: "sqlite"`: Juno compiles the exact same `?`-placeholder SQLite
// SQL it uses for the local sqlite() adapter, and the connection is a plain URL +
// token (no TCP socket, no platform binding) — so it runs on the Vercel Node
// runtime, on edge, and anywhere with fetch. `@libsql/client` is dynamically
// imported: a peer the app installs only when it declares turso(); the host never
// hard-depends on it. Host-free (no node:* / ./host) so it can enter a worker
// bundle, unlike sqlite().

import type { DbFactory, JuneDb, RunResult } from "@junejs/core/resources";

// The slice of @libsql/client's Client we depend on — so libsqlJuneDb is
// unit-testable with a fake (no network).
export interface LibsqlResultSet {
  rows: unknown[];
  rowsAffected: number;
  lastInsertRowid?: bigint | number;
}
export interface LibsqlClientLike {
  execute(stmt: { sql: string; args?: unknown[] } | string): Promise<LibsqlResultSet>;
  executeMultiple?(sql: string): Promise<void>;
  close(): void | Promise<void>;
}

// Wrap a libsql client as a JuneDb. Exported (not just the factory) so the mapping
// — rows, first-row, RunResult, transaction ordering — is testable offline.
export function libsqlJuneDb(client: LibsqlClientLike): JuneDb {
  const self: JuneDb = {
    dialect: "sqlite", // libsql IS sqlite — same SQL + Juno tables as sqlite()/d1()
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.execute({ sql, args: params })).rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return ((await client.execute({ sql, args: params })).rows[0] ?? undefined) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const r = await client.execute({ sql, args: params });
      // libsql returns lastInsertRowid as a bigint; RunResult is number-ish.
      return { changes: r.rowsAffected ?? 0, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    async exec(sql: string) {
      // DDL / migrations are multi-statement; executeMultiple splits on `;`.
      if (client.executeMultiple) await client.executeMultiple(sql);
      else await client.execute(sql);
    },
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      // Test/dev grade, matching postgres()/mysql(): BEGIN/COMMIT on the one
      // client. (For strict isolation over HTTP, libsql's interactive
      // client.transaction() is the upgrade path.)
      await client.execute("BEGIN");
      try {
        const out = await fn(self);
        await client.execute("COMMIT");
        return out;
      } catch (e) {
        await client.execute("ROLLBACK");
        throw e;
      }
    },
    async close() {
      await client.close();
    },
  };
  return self;
}

// `turso({ url, authToken })` — declared in june.config.ts, or omit both to read
// the standard TURSO_DATABASE_URL / TURSO_AUTH_TOKEN env vars at open() time
// (NOT at construction — so the build can evaluate the config without the secrets
// present, and the deployed function reads them from its own environment).
export function turso(opts: { url?: string; authToken?: string } = {}): DbFactory {
  return {
    kind: "turso",
    open: async () => {
      const url = opts.url ?? readEnv("TURSO_DATABASE_URL");
      const authToken = opts.authToken ?? readEnv("TURSO_AUTH_TOKEN");
      if (!url) {
        throw new Error(
          "turso(): no database url — pass { url } or set TURSO_DATABASE_URL in the environment.",
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import("@libsql/client")) as any;
      const createClient = (mod.default ?? mod).createClient;
      return libsqlJuneDb(createClient({ url, authToken }));
    },
  };
}

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}
