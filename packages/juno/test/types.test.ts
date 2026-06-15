// Stage 3 — declared-schema inference. Pure type-level assertions (checked by
// `tsc --noEmit`, included via test/**/*.ts) plus one runtime sanity check that the
// overloads don't change behavior. We augment Juno's `Schema` registry the way a
// generated `db/schema.d.ts` would — through the same relative module the source uses
// — with a collision-free `widgets` table so existing tests' `users`/`posts` calls
// keep their old untyped shape.

import { describe, expect, test } from "bun:test";
import { host } from "@junejs/server/host";

import { juno, type Juno, type Table, type Row } from "../src";

// The augmentation a `june db types` run would emit (Stage 3b), here inline so the
// type machinery is exercised without the codegen. Relative specifier == the one the
// source is compiled under, so the interface merges.
declare module "../src" {
  interface Schema {
    widgets: { id: number; sku: string; price: number; note: string | null };
  }
}

// --- compile-time assertions ---------------------------------------------------
// Assert on real call expressions (so overload RESOLUTION is exercised, not a single
// signature instantiation). This function is never called — it exists only to typecheck.
type Expect<T extends true> = T;
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
  ? true
  : false;
type Widget = { id: number; sku: string; price: number; note: string | null };
type Custom = { a: number };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _typeChecks(j: Juno, name: string) {
  // A declared name infers its row — no inline generic, name autocompletes.
  const known = j.table("widgets");
  type _Known = Expect<Equal<typeof known, Table<Widget & Row>>>;

  // The row flows through the read API: findBy returns the declared row | undefined.
  const row = await known.findBy({ sku: "w1" });
  type _Findby = Expect<Equal<typeof row, (Widget & Row) | undefined>>;

  // A dynamic (non-literal) name falls back to the untyped Table<Row), not an error.
  const dynamic = j.table(name);
  type _Unknown = Expect<Equal<typeof dynamic, Table<Row>>>;

  // A non-declared literal is just a string at the call site → fallback overload.
  const literal = j.table("not_declared");
  type _Literal = Expect<Equal<typeof literal, Table<Row>>>;

  // The explicit inline-generic escape hatch still resolves to the given type.
  const inline = j.table<Custom>("x");
  type _Inline = Expect<Equal<typeof inline, Table<Custom>>>;
}

// --- runtime sanity: overloads are types-only; behavior is unchanged -----------
describe("Stage 3 declared-schema inference (runtime unchanged)", () => {
  test("table(name) on a declared table still reads rows normally", async () => {
    const db = await host.openDb(":memory:");
    await db.exec("create table widgets (id integer primary key, sku text, price integer, note text)");
    await db.run("insert into widgets (sku, price, note) values (?, ?, ?)", ["w1", 10, null]);

    const w = await juno(db).table("widgets").findBy({ sku: "w1" });
    expect(w?.price).toBe(10);
    expect(w?.note).toBeNull();
  });
});
