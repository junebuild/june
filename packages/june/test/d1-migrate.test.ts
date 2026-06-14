// Deploy-time D1 migration: the SAME migrate() runs against a remote D1 through
// a `wrangler d1 execute` transport. Tests drive a stateful FAKE transport (an
// in-memory ledger) so the full orchestration + adapter glue is exercised with
// no wrangler, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inlineParams,
  wranglerD1,
  resolveD1Database,
  migrateD1,
  type D1Exec,
} from "../src/d1-migrate";

describe("inlineParams", () => {
  test("escapes strings, passes numbers, handles null/bool", () => {
    expect(inlineParams("values (?, ?)", ["0001_x", "2026-01-01"])).toBe(
      "values ('0001_x', '2026-01-01')",
    );
    expect(inlineParams("a=?", ["O'Brien"])).toBe("a='O''Brien'"); // SQL-escape the quote
    expect(inlineParams("a=?, b=?, c=?", [3, null, true])).toBe("a=3, b=null, c=1");
  });
});

describe("wranglerD1 adapter (mocked transport)", () => {
  test("query goes through --command --json and returns parsed results", async () => {
    const seen: Array<{ sql: string; mode: string; json: boolean }> = [];
    const exec: D1Exec = async (req) => {
      seen.push(req);
      return {
        stdout: 'wrangler banner\n[{"results":[{"id":"a"},{"id":"b"}],"meta":{}}]',
        stderr: "",
        exitCode: 0,
      };
    };
    const db = wranglerD1({ database: "app-db", configPath: "w.jsonc", cwd: ".", exec });
    const rows = await db.query<{ id: string }>("select id from _june_migrations");
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]); // banner before JSON tolerated
    expect(seen[0]).toMatchObject({ mode: "command", json: true });
  });

  test("run inlines params and reads meta.changes/last_row_id", async () => {
    let received = "";
    const exec: D1Exec = async (req) => {
      received = req.sql;
      return { stdout: '[{"results":[],"meta":{"changes":1,"last_row_id":7}}]', stderr: "", exitCode: 0 };
    };
    const db = wranglerD1({ database: "app-db", configPath: "w.jsonc", cwd: ".", exec });
    const r = await db.run("insert into t (id) values (?)", ["x"]);
    expect(received).toBe("insert into t (id) values ('x')");
    expect(r).toEqual({ changes: 1, lastInsertRowid: 7 });
  });

  test("exec uses file mode (no --command) and surfaces failures", async () => {
    const modes: string[] = [];
    const ok: D1Exec = async (req) => {
      modes.push(req.mode);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await wranglerD1({ database: "d", configPath: "w", cwd: ".", exec: ok }).exec("create table t (id int)");
    expect(modes).toEqual(["file"]);

    const bad: D1Exec = async () => ({ stdout: "", stderr: "D1_ERROR: nope", exitCode: 1 });
    const db = wranglerD1({ database: "d", configPath: "w", cwd: ".", exec: bad });
    expect(db.exec("create table t (id int)")).rejects.toThrow(/D1_ERROR: nope/);
  });
});

// A fake remote D1: just enough to let migrate() run — it tracks the ledger and
// answers the two ledger queries; everything else (DDL, migration bodies) is a
// no-op success.
function fakeD1() {
  const ledger = new Set<string>();
  const applied: string[] = []; // migration bodies actually exec'd (file mode)
  const exec: D1Exec = async ({ sql, mode }) => {
    const low = sql.trim().toLowerCase();
    if (low.startsWith("select id from _june_migrations")) {
      const results = [...ledger].map((id) => ({ id }));
      return { stdout: JSON.stringify([{ results, meta: {} }]), stderr: "", exitCode: 0 };
    }
    if (low.startsWith("insert into _june_migrations")) {
      const m = sql.match(/values\s*\(\s*'([^']*)'/i);
      if (m?.[1]) ledger.add(m[1]);
      return { stdout: JSON.stringify([{ results: [], meta: { changes: 1 } }]), stderr: "", exitCode: 0 };
    }
    if (mode === "file" && !low.startsWith("create table if not exists _june_migrations")) {
      applied.push(sql.trim());
    }
    return { stdout: JSON.stringify([{ results: [], meta: { changes: 0 } }]), stderr: "", exitCode: 0 };
  };
  return { exec, ledger, applied };
}

describe("migrateD1 (full orchestration against fake D1)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const writeMigrations = async (files: Record<string, string>) => {
    dir = await mkdtemp(join(tmpdir(), "june-d1mig-"));
    await mkdir(join(dir, "db", "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(dir, "db", "migrations", name), sql);
    }
  };

  test("applies pending safe migrations in order and records the ledger", async () => {
    await writeMigrations({
      "0001_users.sql": "create table users (id integer primary key, name text)",
      "0002_index.sql": "create index idx_name on users (name)",
    });
    const fake = fakeD1();
    const r = await migrateD1({ appRoot: dir, database: "app-db", configPath: "w", exec: fake.exec });
    expect(r.applied).toEqual(["0001_users.sql", "0002_index.sql"]);
    expect(r.blocked).toBeNull();
    expect([...fake.ledger]).toEqual(["0001_users.sql", "0002_index.sql"]);
  });

  test("idempotent: a second run applies nothing", async () => {
    await writeMigrations({ "0001_users.sql": "create table users (id integer primary key)" });
    const fake = fakeD1();
    await migrateD1({ appRoot: dir, database: "app-db", configPath: "w", exec: fake.exec });
    const second = await migrateD1({ appRoot: dir, database: "app-db", configPath: "w", exec: fake.exec });
    expect(second.applied).toEqual([]); // ledger already has it
  });

  test("destructive migration halts: safe prefix applied, destructive returned not run", async () => {
    await writeMigrations({
      "0001_users.sql": "create table users (id integer primary key)",
      "0002_drop.sql": "drop table users",
    });
    const fake = fakeD1();
    const r = await migrateD1({ appRoot: dir, database: "app-db", configPath: "w", exec: fake.exec });
    expect(r.applied).toEqual(["0001_users.sql"]); // safe prefix only
    expect(r.blocked?.id).toBe("0002_drop.sql");
    expect(r.blocked?.reasons).toContain("DROP TABLE");
    expect(fake.applied).not.toContain("drop table users"); // never executed remotely

    // explicit consent applies it
    const r2 = await migrateD1({
      appRoot: dir,
      database: "app-db",
      configPath: "w",
      exec: fake.exec,
      allowDestructive: true,
    });
    expect(r2.applied).toEqual(["0002_drop.sql"]);
    expect(r2.blocked).toBeNull();
  });
});

describe("resolveD1Database", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("reads database_name from a wrangler jsonc (comments tolerated)", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-d1res-"));
    const cfg = join(dir, "wrangler.jsonc");
    await writeFile(
      cfg,
      `{
        // the june-emitted binding
        "name": "myapp",
        "d1_databases": [{ "binding": "DB", "database_name": "myapp-db", "database_id": "" }]
      }`,
    );
    expect(await resolveD1Database(dir, cfg)).toBe("myapp-db");
  });

  test("falls back to <pkgName>-db when the config has no d1 binding", async () => {
    dir = await mkdtemp(join(tmpdir(), "june-d1res-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "Cool_App" }));
    const cfg = join(dir, "wrangler.jsonc");
    await writeFile(cfg, `{ "name": "x" }`);
    expect(await resolveD1Database(dir, cfg)).toBe("cool-app-db"); // sanitized like build
  });
});
