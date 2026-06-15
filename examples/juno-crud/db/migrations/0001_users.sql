-- Schema is explicit + developer-owned (never auto-created). `june dev` applies
-- this; `june db types` introspects the result into db/schema.d.ts so `table()` is
-- typed with no inline generic. NOT NULL here → `name: string` (not `| null`) there.
create table users (
  id integer primary key,
  name text not null
);
