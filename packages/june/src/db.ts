// `db` resource adapters — implementations of the @junejs/core JuneDb contract.
// Declared in june.config.ts (`resources.db: sqlite(...)` / `d1(...)`), opened
// by the host and made ambient (`import { db } from "@junejs/db"`, via
// runInScope — NOT on ctx). The framework depends on the JuneDb contract; these
// adapters (and Juno on top) are swappable.
//
// This module is HOST-FREE so the generated worker can import it (e.g. `turso`)
// without dragging node:fs / the dev host into the bundle (reminder #4). The two
// host-coupled adapters keep their host touch out of the static graph:
//   - d1()    lives in ./d1 (edge-safe; env binding).
//   - sqlite() is DEV-only and imports node:fs + ./host LAZILY, inside open().
// All five (sqlite/d1/postgres/mysql/turso) are named from this one place.

import type { DbFactory } from "@junejs/core/resources";

export { d1, type D1Database } from "./d1";
export { postgres, pgJuneDb, type PgClientLike } from "./postgres-driver";
export { mysql, mysqlJuneDb, type MysqlConnLike } from "./mysql-driver";
export { turso, libsqlJuneDb, type LibsqlClientLike } from "./turso-driver";

// Local SQLite — the zero-config dev default. A persistent FILE, not :memory:,
// on purpose: `june dev` restarts the process on every save (the watch
// supervisor), so an in-memory default would evaporate your dev data at each
// edit. A file also makes the dev db inspectable with the sqlite3 every
// machine already has (`sqlite3 .june/dev.sqlite`). Pass ":memory:" explicitly
// for ephemerality. node:fs + ./host are imported lazily so this module stays
// host-free (sqlite() only runs in dev, where the imports resolve).
export function sqlite(opts: { path?: string } = {}): DbFactory {
  const path = opts.path ?? ".june/dev.sqlite";
  return {
    kind: "sqlite",
    open: async () => {
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { host } = await import("./host");
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      return host.openDb(path);
    },
  };
}
