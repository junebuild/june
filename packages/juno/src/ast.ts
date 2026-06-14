// Operation-node AST — the immutable shape a query compiles from. Stage 1 covers
// exactly what the table API emits today (select with equality `where` + optional
// limit, insert, update, delete, upsert); Stage 2 grows where-operators / joins /
// order. Nodes carry SHAPE only (table + column names), never parameter values —
// so a node IS its own structural cache key for compile-once. A dialect compiler
// (compiler.ts) walks these; placeholders/quoting/upsert syntax vary by subclass.

export type Node = SelectNode | InsertNode | UpdateNode | DeleteNode | UpsertNode;

// Comparison operators a WHERE predicate can use (Stage 2). `in` is variadic — its
// placeholder count is the value array's length, so it carries `arity` (which makes
// the SQL shape, hence the compile-once key, depend on the list length).
export type CmpOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like";
export type Predicate = { col: string; op: CmpOp } | { col: string; op: "in"; arity: number };
export type OrderTerm = { col: string; dir: "asc" | "desc" };

// `select * from <from> [where <pred> and ...] [order by ...] [limit ?] [offset ?]`.
// Predicates are AND-joined (OR → the raw escape hatch). `limit` is a literal number
// (findBy's `limit 1`) or "param" (bound, so all limits share one compiled SQL);
// `offset` is always bound.
export type SelectNode = {
  kind: "select";
  from: string;
  where: Predicate[];
  orderBy?: OrderTerm[];
  limit?: number | "param";
  offset?: "param";
};

export type InsertNode = {
  kind: "insert";
  into: string;
  columns: string[];
};

export type UpdateNode = {
  kind: "update";
  table: string;
  set: string[];
  where: string[];
};

export type DeleteNode = {
  kind: "delete";
  from: string;
  where: string[];
};

// `insert into <into> (cols) values (?) on conflict (conflict) do update set
// <update[i]> = excluded.<update[i]> returning *`.
export type UpsertNode = {
  kind: "upsert";
  into: string;
  columns: string[];
  conflict: string[];
  update: string[];
};
