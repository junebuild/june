// `db` resource adapters — implementations of the @junejs/core JuneDb contract.
// Declared in june.config.ts (`resources.db: sqlite(...)` / `d1(...)`), opened
// by the host, injected onto RouteContext as `ctx.db`. The framework depends on
// the JuneDb contract; these adapters (and Juno on top) are swappable.
//
// sqlite() is host-coupled (node:fs + ./host) and DEV-only. The edge-safe d1()
// adapter lives in ./d1 so the generated worker can import it without dragging
// this module's host imports into the workerd bundle; it is re-exported here so
// `@junejs/server/db` stays the one place both db adapters are named.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DbFactory } from "@junejs/core/resources";

import { host } from "./host";

export { d1, type D1Database } from "./d1";

// Local SQLite — the zero-config dev default. A persistent FILE, not :memory:,
// on purpose: `june dev` restarts the process on every save (the watch
// supervisor), so an in-memory default would evaporate your dev data at each
// edit. A file also makes the dev db inspectable with the sqlite3 every
// machine already has (`sqlite3 .june/dev.sqlite`). Pass ":memory:" explicitly
// for ephemerality.
export function sqlite(opts: { path?: string } = {}): DbFactory {
  const path = opts.path ?? ".june/dev.sqlite";
  return {
    kind: "sqlite",
    open: () => {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      return host.openDb(path);
    },
  };
}
