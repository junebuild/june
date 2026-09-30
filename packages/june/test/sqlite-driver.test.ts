// The local-sqlite driver layer: it picks the runtime's built-in sqlite and,
// on Node too old for node:sqlite, turns the cryptic builtin-module failure into
// actionable guidance. The round-trip runs on whichever runtime hosts the suite
// (bun:sqlite or node:sqlite); the help message is unit-tested directly.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openLocalSqlite,
  openLocalSqliteSync,
  nodeSqliteHelp,
  NODE_SQLITE_MIN_LTS,
  NODE_SQLITE_MIN_ODD,
  isNodeSqliteExperimentalWarning,
  makeWarningFilter,
} from "../src/sqlite-driver";

describe("openLocalSqlite", () => {
  test("opens the runtime's built-in sqlite and round-trips through JuneDb", async () => {
    const db = await openLocalSqlite(":memory:");
    await db.exec("create table t (id integer primary key, v text)");
    const r = await db.run("insert into t (v) values (?)", ["hi"]);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(await db.get<{ v: string }>("select v from t where id = ?", [1])).toEqual({ v: "hi" });
    expect(await db.query<{ v: string }>("select v from t")).toEqual([{ v: "hi" }]);
    // missing row → undefined (the bun/node null-vs-undefined seam)
    expect(await db.get<{ v: string }>("select v from t where id = ?", [999])).toBeUndefined();
    await db.close();
  });

  test("transaction commits on success and rolls back on throw", async () => {
    const db = await openLocalSqlite(":memory:");
    await db.exec("create table t (id integer primary key, v text)");
    await db.transaction(async (tx) => {
      await tx.run("insert into t (v) values (?)", ["committed"]);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.run("insert into t (v) values (?)", ["rolled-back"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select v from t")).toEqual([{ v: "committed" }]);
    await db.close();
  });
});

describe("durable journal on file databases", () => {
  const pragmas = async (path: string) => {
    const db = await openLocalSqliteSync(path);
    const out = {
      journal: (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      sync: (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
    };
    db.close();
    return out;
  };

  test("a file database opens in WAL with synchronous=FULL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "june-sqlite-"));
    try {
      expect(await pragmas(join(dir, "app.sqlite"))).toEqual({ journal: "wal", sync: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing DELETE-mode file is switched to WAL on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "june-sqlite-"));
    const path = join(dir, "old.sqlite");
    try {
      const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite");
      const old = new Database(path, { create: true });
      old.exec("PRAGMA journal_mode=DELETE");
      old.exec("create table t (v text)");
      old.close();
      expect((await pragmas(path)).journal).toBe("wal");
      // the mode persists in the file, so a plain sqlite3 / other reader sees WAL too
      const again = new Database(path);
      expect((again.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(":memory: is left alone", async () => {
    expect((await pragmas(":memory:")).journal).toBe("memory");
  });

  test("the native agent store is a WAL file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "june-agent-"));
    const path = join(dir, "agent.db");
    try {
      const { createNativeRuntime } = await import("../src/agent-native");
      const rt = await createNativeRuntime({}, path);
      await rt.close();
      expect((await pragmas(path)).journal).toBe("wal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nodeSqliteHelp (the version-cliff guidance)", () => {
  test("names the running version and both escape hatches", () => {
    const msg = nodeSqliteHelp("20.11.0");
    expect(msg).toContain("v20.11.0");
    expect(msg).toContain(NODE_SQLITE_MIN_LTS); // 22.13.0
    expect(msg).toContain(NODE_SQLITE_MIN_ODD); // 23.4.0
    expect(msg).toContain("--experimental-sqlite"); // explains the flagged middle band
    expect(msg.toLowerCase()).toContain("bun"); // the no-version-floor alternative
  });

  test("the version floor is the flag-free node:sqlite release", () => {
    expect(NODE_SQLITE_MIN_LTS).toBe("22.13.0");
    expect(NODE_SQLITE_MIN_ODD).toBe("23.4.0");
  });
});

describe("ExperimentalWarning silencing (node:sqlite first-run noise)", () => {
  test("matches ONLY the node:sqlite experimental warning", () => {
    expect(isNodeSqliteExperimentalWarning("ExperimentalWarning", "SQLite is an experimental feature")).toBe(true);
    expect(isNodeSqliteExperimentalWarning("ExperimentalWarning", "Type Stripping is experimental")).toBe(false);
    expect(isNodeSqliteExperimentalWarning("DeprecationWarning", "SQLite something")).toBe(false);
    expect(isNodeSqliteExperimentalWarning(undefined, "SQLite")).toBe(false);
  });

  test("filter drops the sqlite warning and forwards everything else verbatim", () => {
    const seen: Array<[string | Error, unknown[]]> = [];
    const filter = makeWarningFilter((w, ...rest) => seen.push([w, rest]));

    filter("SQLite is an experimental feature", "ExperimentalWarning"); // dropped
    filter("SQLite is an experimental feature", { type: "ExperimentalWarning" }); // dropped (options form)
    filter("Some deprecation", "DeprecationWarning"); // forwarded
    filter(new Error("other experimental"), "ExperimentalWarning"); // forwarded (not sqlite)

    expect(seen).toHaveLength(2);
    expect(seen[0]![0]).toBe("Some deprecation");
    expect((seen[1]![0] as Error).message).toBe("other experimental");
  });
});
