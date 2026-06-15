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
    expect(out).toContain("  users: {");
    expect(out).toContain("    id: number;"); // INTEGER PK → not null
    expect(out).toContain("    email: string;"); // TEXT NOT NULL
    expect(out).toContain("    name: string | null;"); // TEXT nullable
    expect(out).toContain("    age: number | null;"); // INTEGER nullable
    expect(out).toContain("    balance: number;"); // REAL NOT NULL
    expect(out).toContain("    avatar: Uint8Array | null;"); // BLOB nullable
    expect(out).toContain("    nick: string | null;"); // varchar → CHAR affinity
    expect(out).toContain("    is_admin: number;"); // boolean → NUMERIC affinity
  });

  test("skips the migration ledger and sqlite internals", async () => {
    const out = await emitSchemaTypes(await seed());
    expect(out).not.toContain("_june_migrations");
    expect(out).not.toContain("sqlite_");
  });

  test("quotes table/column names that aren't safe identifiers", async () => {
    const out = await emitSchemaTypes(await seed());
    expect(out).toContain('"weird-name": {'); // hyphen → quoted key
    expect(out).toContain("    from: string;"); // reserved word is fine bare in a TS member
  });

  test("tables are emitted in stable (alphabetical) order", async () => {
    const out = await emitSchemaTypes(await seed());
    expect(out.indexOf("users:")).toBeLessThan(out.indexOf('"weird-name":'));
  });
});
