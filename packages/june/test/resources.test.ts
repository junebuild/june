// The resource seam: a config-declared `db` resource is injected onto
// RouteContext as ctx.db; not declaring it leaves ctx.db undefined. Proves the
// binding model (declare in config → injected handle) end-to-end, plus the D1
// adapter mapping. See docs/data-layer-boundary.md.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { sqlite, d1, type D1Database } from "../src/db";
import { host } from "../src/host";

const APP_DIR = fileURLToPath(new URL("./fixtures/db/app", import.meta.url));

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "june-res-"));
  dbPath = join(dir, "test.db");
  // Seed through the host primitive; the app opens the same file via sqlite().
  const seed = await host.openDb(dbPath);
  await seed.exec("create table users (id integer primary key, name text)");
  await seed.run("insert into users (name) values (?)", ["Ada"]);
  await seed.run("insert into users (name) values (?)", ["Linus"]);
  await seed.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const json = async (app: ReturnType<typeof createApp>, path: string) =>
  (await app.fetch(new Request(`http://june.test${path}`))).json();

describe("ctx.db injection (the binding model)", () => {
  test("a declared sqlite resource is injected and queryable", async () => {
    const app = createApp({ appDir: APP_DIR, config: { resources: { db: sqlite({ path: dbPath }) } } });
    expect(await json(app, "/.json")).toEqual({ users: [{ name: "Ada" }, { name: "Linus" }] });
  });

  test("sqlite() creates missing parent dirs and persists across reopen (the watch-restart shape)", async () => {
    // The default is a FILE under .june/ — dev restarts on every save, so the
    // data must outlive the process. Simulate two processes via two factories.
    const nested = join(dir, "deep/never/created/dev.sqlite");
    const first = await sqlite({ path: nested }).open();
    await first.exec("create table notes (id integer primary key, body text)");
    await first.run("insert into notes (body) values (?)", ["survives restarts"]);
    await first.close();

    const second = await sqlite({ path: nested }).open();
    expect(await second.query("select body from notes")).toEqual([{ body: "survives restarts" }]);
    await second.close();
  });

  test("no declared resource → ctx.db is undefined (route degrades, no crash)", async () => {
    const app = createApp({ appDir: APP_DIR, config: {} });
    expect(await json(app, "/.json")).toEqual({ users: [] });
  });

  test("the same handle is reused across requests (memoized, one connection)", async () => {
    const app = createApp({ appDir: APP_DIR, config: { resources: { db: sqlite({ path: dbPath }) } } });
    const a = await json(app, "/.json");
    const b = await json(app, "/.json");
    expect(a).toEqual(b);
  });
});

describe("d1 adapter maps the D1 surface to the JuneDb contract", () => {
  test("query / run translate prepare().bind().all()/run()", async () => {
    const calls: string[] = [];
    const fakeD1: D1Database = {
      prepare(sql: string) {
        const stmt = {
          bind: (...v: unknown[]) => {
            calls.push(`${sql} :: ${JSON.stringify(v)}`);
            return stmt;
          },
          all: async <T>() => ({ results: [{ id: 1, name: "Ada" }] as T[] }),
          first: async <T>() => ({ id: 1, name: "Ada" }) as T,
          run: async () => ({ meta: { changes: 1, last_row_id: 7 } }),
        };
        return stmt;
      },
      exec: async () => ({}),
    };

    const db = await d1(fakeD1).open();
    expect(await db.query("select * from users where id = ?", [1])).toEqual([{ id: 1, name: "Ada" }]);
    expect(await db.run("insert into users (name) values (?)", ["Ada"])).toEqual({
      changes: 1,
      lastInsertRowid: 7,
    });
    expect(calls).toContain(`select * from users where id = ? :: [1]`);
  });
});
