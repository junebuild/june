// Migrations — the explicit, versioned schema story (Rails-shaped, adapted).
//
// `db/migrations/NNNN_name.sql` are applied IN ORDER; a `_june_migrations` ledger
// tracks which ran, so applying is idempotent. The deliberate design (see the
// data-layer discussion): never CREATE tables just because a db is connected —
// schema is an explicit, developer-owned artifact. Dev auto-applies the SAFE
// (additive) migrations; a DESTRUCTIVE one (data loss) STOPS and asks for
// explicit consent rather than silently dropping data. Production never
// auto-migrates: `june db migrate` is the explicit step.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JuneDb } from "@junejs/core/resources";
import type { JuneConfig } from "@junejs/core/config";

export type Migration = { id: string; sql: string };
export type ClassifiedMigration = Migration & { destructive: boolean; reasons: string[] };
export type MigrateResult = {
  applied: string[]; // ids applied this run, in order
  blocked: ClassifiedMigration | null; // the destructive migration that halted, if any
};

// Static DDL danger classifier. We flag DATA-LOSS verbs; additive DDL
// (CREATE / ADD COLUMN / INSERT / CREATE INDEX) and pragmas/transactions are
// safe. Conservative on RECALL — any destructive verb present gates the whole
// migration: a false positive costs one confirmation, a false negative costs
// data, so we err toward gating.
const DESTRUCTIVE: Array<{ re: RegExp; label: string }> = [
  { re: /\bdrop\s+table\b/i, label: "DROP TABLE" },
  { re: /\bdrop\s+index\b/i, label: "DROP INDEX" },
  { re: /\bdrop\s+view\b/i, label: "DROP VIEW" },
  { re: /\bdrop\s+trigger\b/i, label: "DROP TRIGGER" },
  { re: /\bdelete\s+from\b/i, label: "DELETE" },
  { re: /\btruncate\b/i, label: "TRUNCATE" },
  // SQLite rewrites for column drop/rename go through ALTER TABLE … DROP/RENAME.
  { re: /\balter\s+table\b[\s\S]*?\bdrop\b/i, label: "ALTER TABLE … DROP" },
  { re: /\balter\s+table\b[\s\S]*?\brename\b/i, label: "ALTER TABLE … RENAME" },
];

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function classify(sql: string): { destructive: boolean; reasons: string[] } {
  const clean = stripComments(sql);
  const reasons = DESTRUCTIVE.filter((d) => d.re.test(clean)).map((d) => d.label);
  return { destructive: reasons.length > 0, reasons };
}

// Read db/migrations/*.sql in lexical order — zero-padded numeric prefixes
// (0001_, 0002_) sort correctly and double as the version id.
export async function readMigrations(dir: string): Promise<Migration[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (id) => ({ id, sql: await readFile(join(dir, id), "utf8") })));
}

async function ensureLedger(db: JuneDb): Promise<void> {
  await db.exec(
    `create table if not exists _june_migrations (id text primary key, applied_at text not null)`,
  );
}

export async function appliedIds(db: JuneDb): Promise<Set<string>> {
  await ensureLedger(db);
  const rows = await db.query<{ id: string }>("select id from _june_migrations");
  return new Set(rows.map((r) => r.id));
}

// Apply pending migrations in order. Stops at the first DESTRUCTIVE one unless
// allowDestructive — migrations are ordered (a later one may depend on it), so
// the safe prefix is applied and the destructive one is returned for the caller
// to surface (dev warns; `june db migrate --allow-destructive` proceeds).
export async function migrate(
  db: JuneDb,
  dir: string,
  opts: { allowDestructive?: boolean; now?: string } = {},
): Promise<MigrateResult> {
  const already = await appliedIds(db);
  const pending = (await readMigrations(dir)).filter((m) => !already.has(m.id));
  const stamp = opts.now ?? new Date().toISOString();
  const applied: string[] = [];
  for (const m of pending) {
    const c = classify(m.sql);
    if (c.destructive && !opts.allowDestructive) {
      return { applied, blocked: { ...m, ...c } };
    }
    await db.exec(m.sql);
    await db.run("insert into _june_migrations (id, applied_at) values (?, ?)", [m.id, stamp]);
    applied.push(m.id);
  }
  return { applied, blocked: null };
}

// Open the app's declared db, apply migrations from <root>/db/migrations, close.
// Returns null when no db resource is declared (nothing to migrate). The CLI and
// dev startup both call this; they own the logging/exit semantics.
export async function migrateApp(
  root: string,
  config: JuneConfig,
  opts: { allowDestructive?: boolean } = {},
): Promise<MigrateResult | null> {
  const factory = config.resources?.db;
  if (!factory) return null;
  const db = await factory.open();
  try {
    return await migrate(db, join(root, "db", "migrations"), opts);
  } finally {
    await db.close();
  }
}

// `june db types`: open the declared db, bring it to head (safe migrations only, so
// the schema is present even on a fresh checkout), then hand it to the data layer's
// codegen hook for the type-declaration text. Returns null when there's no db or the
// data layer doesn't generate types — the CLI owns the messaging. Introspection is
// read-only; the safe migrate is idempotent (the ledger skips applied ones).
export async function typesApp(root: string, config: JuneConfig): Promise<string | null> {
  const factory = config.resources?.db;
  const emit = config.dataLayer?.emitTypes;
  if (!factory || !emit) return null;
  const db = await factory.open();
  try {
    await migrate(db, join(root, "db", "migrations"), { allowDestructive: false });
    return await emit(db);
  } finally {
    await db.close();
  }
}

// The "this migration was gated" guidance, shared by dev (warns, keeps serving)
// and `june db migrate` (exits non-zero).
export function blockedMessage(m: ClassifiedMigration): string {
  return (
    `migration ${m.id} is destructive (${m.reasons.join(", ")}) and was NOT applied.\n` +
    `  review it, then apply explicitly: june db migrate --allow-destructive`
  );
}
