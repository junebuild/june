// Operation-node AST — the immutable shape a query compiles from. Stage 1 covers
// exactly what the table API emits today (select with equality `where` + optional
// limit, insert, update, delete, upsert); Stage 2 grows where-operators / joins /
// order. Nodes carry SHAPE only (table + column names), never parameter values —
// so a node IS its own structural cache key for compile-once. A dialect compiler
// (compiler.ts) walks these; placeholders/quoting/upsert syntax vary by subclass.

export type Node = SelectNode | InsertNode | UpdateNode | DeleteNode | UpsertNode;

// `select * from <from> [where <c0> = ? and ...] [limit <n>]`. `where` is the
// list of equality columns (the only predicate Stage 1 emits).
export type SelectNode = {
  kind: "select";
  from: string;
  where: string[];
  limit?: number;
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
