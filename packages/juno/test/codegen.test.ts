// Stage 3b — schema codegen. Introspect a migrated db and assert the emitted
// `declare module` text: type-affinity mapping, nullability, key quoting, and that
// internal tables are skipped. The 3a type-test proves such a declaration makes
// table() infer; this proves introspection produces the right declaration.

import { describe, expect, test } from "bun:test";
import { host } from "@junejs/server/host";
import type { JuneDb } from "@junejs/core/resources";

import { emitSchemaTypes } from "../src";

async function seed(): Promise<JuneDb> {
  const db = await host.openDb(":memory:");
  // A migration ledger (must be skipped) + a sqlite_ internal (auto, also skipped).
  await db.exec("create table _june_migrations (id text primary key, applied_at text not null)");
  await db.exec(
    `create table users (
       id integer primary key,        -- number, not null (rowid alias)
       email text not null,           -- string
       name text,                     -- string | null
       age integer,                   -- number | null
       balance real not null,         -- number
       avatar blob,                   -- Uint8Array | null
       nick varchar(40),              -- string | null (CHAR affinity)
       is_admin boolean not null      -- number (NUMERIC affinity)
     )`,
  );
  await db.exec(`create table "weird-name" (id integer primary key, "from" text not null)`);
  return db;
}

describe("emitSchemaTypes (introspection → declare module)", () => {
  test("emits a @junejs/juno augmentation with affinity + nullability", async () => {
    const out = await emitSchemaTypes(await seed());

    expect(out).toContain('declare module "@junejs/juno" {');
    expect(out).toContain("interface Schema {");
    expect(out).toContain('import "@junejs/juno";');

    // users table, column by column.
    expect(out).toContain("    users: {");
    expect(out).toContain("      id: number;"); // INTEGER PK → not null
    expect(out).toContain("      email: string;"); // TEXT NOT NULL
    expect(out).toContain("      name: string | null;"); // TEXT nullable
    expect(out).toContain("      age: number | null;"); // INTEGER nullable
    expect(out).toContain("      balance: number;"); // REAL NOT NULL
    expect(out).toContain("      avatar: Uint8Array | null;"); // BLOB nullable
    expect(out).toContain("      nick: string | null;"); // varchar → CHAR affinity
    expect(out).toContain("      is_admin: number;"); // boolean → NUMERIC affinity
  });

  test("skips the migration ledger and sqlite internals", async () => {
    const out = await emitSchemaTypes(await seed());
    expect(out).not.toContain("_june_migrations");
    expect(out).not.toContain("sqlite_");
  });

  test("quotes table/column names that aren't safe identifiers", async () => {
    const out = await emitSchemaTypes(await seed());
    expect(out).toContain('    "weird-name": {'); // hyphen → quoted key
    expect(out).toContain("      from: string;"); // reserved word is fine bare in a TS member
  });

  test("tables are emitted in stable (alphabetical) order", async () => {
    const out = await emitSchemaTypes(await seed());
    expect(out.indexOf("users:")).toBeLessThan(out.indexOf('"weird-name":'));
  });
});

// A fake information_schema db: answers the tables query and the per-table columns
// query from a fixture, so the PG/MySQL type maps are tested without a live server.
function catalogDb(
  dialect: "postgres" | "mysql",
  tables: Record<string, { name: string; type: string; nullable: "YES" | "NO" }[]>,
): JuneDb {
  const db = {
    dialect,
    async query(sql: string, params: unknown[] = []) {
      if (/information_schema\.tables/.test(sql)) return Object.keys(tables).sort().map((name) => ({ name }));
      if (/information_schema\.columns/.test(sql)) return tables[params[0] as string] ?? [];
      return [];
    },
    async get() {
      return undefined;
    },
    async run() {
      return { changes: 0, lastInsertRowid: 0 };
    },
    async exec() {},
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      return fn(db);
    },
    async close() {},
  } as JuneDb;
  return db;
}

describe("emitSchemaTypes — Postgres (information_schema)", () => {
  test("maps PG data_types to the types node-postgres returns; nullability from is_nullable", async () => {
    const out = await emitSchemaTypes(
      catalogDb("postgres", {
        users: [
          { name: "id", type: "integer", nullable: "NO" },
          { name: "big", type: "bigint", nullable: "NO" }, // pg returns as string
          { name: "email", type: "character varying", nullable: "NO" },
          { name: "bio", type: "text", nullable: "YES" },
          { name: "balance", type: "numeric", nullable: "YES" }, // string
          { name: "active", type: "boolean", nullable: "NO" },
          { name: "created_at", type: "timestamp with time zone", nullable: "NO" }, // Date
          { name: "avatar", type: "bytea", nullable: "YES" },
          { name: "meta", type: "jsonb", nullable: "YES" },
        ],
      }),
    );
    expect(out).toContain('declare module "@junejs/juno"');
    expect(out).toContain("    users: {");
    expect(out).toContain("      id: number;");
    expect(out).toContain("      big: string;");
    expect(out).toContain("      email: string;");
    expect(out).toContain("      bio: string | null;");
    expect(out).toContain("      balance: string | null;");
    expect(out).toContain("      active: boolean;");
    expect(out).toContain("      created_at: Date;");
    expect(out).toContain("      avatar: Uint8Array | null;");
    expect(out).toContain("      meta: unknown | null;");
  });
});

describe("emitSchemaTypes — MySQL (information_schema)", () => {
  test("maps MySQL data_types to mysql2's defaults; nullability from is_nullable", async () => {
    const out = await emitSchemaTypes(
      catalogDb("mysql", {
        posts: [
          { name: "id", type: "int", nullable: "NO" },
          { name: "views", type: "bigint", nullable: "NO" },
          { name: "title", type: "varchar", nullable: "NO" },
          { name: "body", type: "text", nullable: "YES" },
          { name: "price", type: "decimal", nullable: "YES" }, // string
          { name: "published_at", type: "datetime", nullable: "YES" }, // Date
          { name: "data", type: "json", nullable: "YES" },
          { name: "thumb", type: "blob", nullable: "YES" },
        ],
      }),
    );
    expect(out).toContain("    posts: {");
    expect(out).toContain("      id: number;");
    expect(out).toContain("      views: number;");
    expect(out).toContain("      title: string;");
    expect(out).toContain("      body: string | null;");
    expect(out).toContain("      price: string | null;");
    expect(out).toContain("      published_at: Date | null;");
    expect(out).toContain("      data: unknown | null;");
    expect(out).toContain("      thumb: Uint8Array | null;");
  });

  test("skips the _june_migrations ledger via the WHERE clause (not in fixture → absent)", async () => {
    const out = await emitSchemaTypes(catalogDb("mysql", { posts: [{ name: "id", type: "int", nullable: "NO" }] }));
    expect(out).not.toContain("_june_migrations");
  });
});
