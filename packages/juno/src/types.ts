// Stage 3b / step 4 — schema codegen. Introspect a migrated database and emit the
// `declare module "@junejs/juno"` augmentation that powers Stage 3a's `table()`
// inference. `june db types` writes the result to db/schema.d.ts. The schema of record
// stays in SQL (db/migrations/); this only DERIVES types from it, so the two never
// drift. Multi-dialect: sqlite/D1 via PRAGMA, Postgres/MySQL via information_schema —
// dispatched on the JuneDb's `dialect` tag.

import type { JuneDb } from "@junejs/core/resources";

type Field = { name: string; ts: string };

// Bare identifier if it's a safe JS property name, else a quoted key.
function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

const nul = (ts: string, nullable: boolean) => (nullable ? `${ts} | null` : ts);

// --- SQLite / D1 — PRAGMA + type affinity -------------------------------------
type SqliteCol = { name: string; type: string; nn: number; pk: number };

function sqliteType(declared: string, notnull: number, pk: number): string {
  const t = declared.toUpperCase();
  let base: string;
  if (t.includes("INT")) base = "number"; // INTEGER affinity
  else if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) base = "string"; // TEXT
  else if (t === "" || t.includes("BLOB")) base = "Uint8Array"; // BLOB
  else if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) base = "number"; // REAL
  else base = "number"; // NUMERIC (decimal / boolean / date stored as 0/1/epoch)
  // Nullable unless declared NOT NULL or part of the PK (an INTEGER PRIMARY KEY shows
  // notnull=0 but is the never-null rowid alias).
  return nul(base, notnull === 0 && pk === 0);
}

async function introspectSqlite(db: JuneDb): Promise<[string, Field[]][]> {
  const tables = await db.query<{ name: string }>(
    "select name from sqlite_master where type = 'table' " +
      "and name not like 'sqlite_%' and name <> '_june_migrations' order by name",
  );
  const out: [string, Field[]][] = [];
  for (const { name } of tables) {
    // pragma_table_info(?) — table-valued form takes a BOUND param (injection-safe).
    const cols = await db.query<SqliteCol>('select name, type, "notnull" as nn, pk from pragma_table_info(?)', [name]);
    out.push([name, cols.map((c) => ({ name: c.name, ts: sqliteType(c.type, c.nn, c.pk) }))]);
  }
  return out;
}

// --- information_schema (Postgres / MySQL) ------------------------------------
type InfoCol = { name: string; type: string; nullable: string };

// Postgres data_type → TS, matching what node-postgres actually returns: timestamps/
// dates parse to Date, bigint/numeric come back as string (precision), bytea as bytes.
function postgresType(dataType: string, nullable: boolean): string {
  const t = dataType.toLowerCase();
  let base: string;
  if (t === "boolean") base = "boolean";
  else if (t === "smallint" || t === "integer" || t === "real" || t === "double precision") base = "number";
  else if (t === "bigint" || t === "numeric" || t === "decimal") base = "string";
  else if (t === "bytea") base = "Uint8Array";
  else if (t === "json" || t === "jsonb") base = "unknown";
  else if (t === "date" || t.startsWith("timestamp")) base = "Date";
  else if (t === "uuid" || t === "text" || t.startsWith("character") || t === "name" || t.startsWith("time")) base = "string";
  else base = "unknown";
  return nul(base, nullable);
}

// MySQL data_type → TS, matching mysql2's defaults: DATE/DATETIME/TIMESTAMP → Date,
// DECIMAL → string, BLOB/BINARY → bytes, JSON parsed (unknown).
function mysqlType(dataType: string, nullable: boolean): string {
  const t = dataType.toLowerCase();
  let base: string;
  if (["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "float", "double", "year"].includes(t)) base = "number";
  else if (t === "decimal" || t === "numeric") base = "string";
  else if (["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "enum", "set", "time"].includes(t)) base = "string";
  else if (t === "date" || t === "datetime" || t === "timestamp") base = "Date";
  else if (t === "json") base = "unknown";
  else if (t.includes("blob") || t.includes("binary") || t === "bit") base = "Uint8Array";
  else base = "unknown";
  return nul(base, nullable);
}

// Generic information_schema walk; `ph` is the dialect's placeholder, `scope` the SQL
// expression for the current schema (current_schema() / database()), `map` the type map.
async function introspectInfoSchema(
  db: JuneDb,
  ph: string,
  scope: string,
  map: (dataType: string, nullable: boolean) => string,
): Promise<[string, Field[]][]> {
  const tables = await db.query<{ name: string }>(
    `select table_name as name from information_schema.tables ` +
      `where table_schema = ${scope} and table_type = 'BASE TABLE' ` +
      `and table_name <> '_june_migrations' order by table_name`,
  );
  const out: [string, Field[]][] = [];
  for (const { name } of tables) {
    const cols = await db.query<InfoCol>(
      `select column_name as name, data_type as type, is_nullable as nullable ` +
        `from information_schema.columns where table_schema = ${scope} and table_name = ${ph} ` +
        `order by ordinal_position`,
      [name],
    );
    out.push([name, cols.map((c) => ({ name: c.name, ts: map(c.type, c.nullable === "YES") }))]);
  }
  return out;
}

// --- assembly + dispatch ------------------------------------------------------
function assemble(tables: [string, Field[]][]): string {
  const ifaces = tables.map(([name, fields]) => {
    const lines = fields.map((f) => `      ${propKey(f.name)}: ${f.ts};`).join("\n");
    return `    ${propKey(name)}: {\n${lines}\n    };`;
  });
  return (
    "// Generated by `june db types`. Do not edit — re-run after a migration.\n" +
    'import "@junejs/juno";\n\n' +
    'declare module "@junejs/juno" {\n' +
    "  interface Schema {\n" +
    ifaces.join("\n") +
    "\n  }\n}\n"
  );
}

// Introspect every user table (skipping the migration ledger + engine internals) and
// emit the augmentation text. Reads only — never mutates the database.
export async function emitSchemaTypes(db: JuneDb): Promise<string> {
  const dialect = db.dialect ?? "sqlite";
  const tables =
    dialect === "postgres"
      ? await introspectInfoSchema(db, "$1", "current_schema()", postgresType)
      : dialect === "mysql"
        ? await introspectInfoSchema(db, "?", "database()", mysqlType)
        : await introspectSqlite(db);
  return assemble(tables);
}
