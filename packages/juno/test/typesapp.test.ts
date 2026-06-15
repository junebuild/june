// Stage 3b end-to-end through the DataLayer seam: `typesApp(root, config)` opens the
// declared db, applies db/migrations, and calls config.dataLayer.emitTypes — i.e. the
// exact path `june db types` runs. Proves the wiring (config-declared junoDataLayer →
// migrated schema → augmentation text) without the framework importing Juno.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqlite } from "@junejs/server";
import { typesApp } from "@junejs/server";
import type { JuneConfig } from "@junejs/core/config";

import { junoDataLayer } from "../src";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function appWithMigrations(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "june-typesapp-"));
  const md = join(dir, "db", "migrations");
  await mkdir(md, { recursive: true });
  for (const [name, sql] of Object.entries(files)) await writeFile(join(md, name), sql);
  return dir;
}

describe("typesApp (the `june db types` path)", () => {
  test("migrates then emits the augmentation for the resulting schema", async () => {
    const root = await appWithMigrations({
      "0001_users.sql": "create table users (id integer primary key, email text not null);",
      "0002_add_name.sql": "alter table users add column name text;", // later migration reflected
    });
    const config: JuneConfig = {
      resources: { db: sqlite({ path: ":memory:" }) },
      dataLayer: junoDataLayer(),
    };

    const out = await typesApp(root, config);
    expect(out).toContain('declare module "@junejs/juno"');
    expect(out).toContain("  users: {");
    expect(out).toContain("    id: number;");
    expect(out).toContain("    email: string;");
    expect(out).toContain("    name: string | null;"); // the second migration's column
  });

  test("returns null when the data layer has no emitTypes hook", async () => {
    const root = await appWithMigrations({ "0001.sql": "create table t (id integer primary key);" });
    const bare: JuneConfig = {
      resources: { db: sqlite({ path: ":memory:" }) },
      dataLayer: { install() {}, module: "x" }, // a Tier-3 layer without codegen
    };
    expect(await typesApp(root, bare)).toBeNull();
  });
});
