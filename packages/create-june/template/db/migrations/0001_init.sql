-- Migrations are explicit and versioned. `june dev` applies pending ones on
-- startup (safe/additive automatically; a destructive change asks first). Add
-- the next change as db/migrations/0002_*.sql — never edit an applied file.

create table if not exists users (
  id integer primary key autoincrement,
  name text not null
);

-- A little seed so the app has something to show on first run.
insert into users (name) values ('Ada'), ('Grace');
