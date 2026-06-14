// juno spike: a compile-once table core for better-sqlite3.
//
// Thesis: the abstraction (typed columns, query shape) is paid ONCE at compile
// time. The hot path is: bind params -> stmt.run/get/all -> mapped row. Row
// mapping uses better-sqlite3 .raw() + a codegen'd monomorphic mapper.
//
// NOTE: this is a throwaway PROTOTYPE to bound what the ergonomic surface can
// achieve, NOT the shipping @junejs/juno (which is async over the JuneDb
// contract). It exists only to prove the compile-once ceiling vs the raw floor.

function genMapper(columns) {
  const body = 'return {' + columns.map((c, i) => `${JSON.stringify(c.prop)}:r[${i}]`).join(',') + '}';
  return new Function('r', body);
}

export class Table {
  constructor(db, name, columns) {
    this.db = db; this.name = name; this.columns = columns;
    this._stmtCache = new Map();
    this._selectList = columns.map(c => c.col).join(',');
    this._allMapper = genMapper(columns);
    // precompile insert with NAMED params aligned to prop names -> pass object straight through
    const colList = columns.map(c => c.col).join(',');
    const valList = columns.map(c => '@' + c.prop).join(',');
    this._insertSql = `INSERT INTO ${name} (${colList}) VALUES (${valList})`;
  }
  _prepared(sql, { raw = false } = {}) {
    let e = this._stmtCache.get(sql);
    if (!e) { const stmt = this.db.prepare(sql); if (raw) stmt.raw(true); e = { stmt }; this._stmtCache.set(sql, e); }
    return e;
  }
  findById(id) {
    const { stmt } = this._prepared(`SELECT ${this._selectList} FROM ${this.name} WHERE id=?`, { raw: true });
    const row = stmt.get(id);
    return row === undefined ? undefined : this._allMapper(row);
  }
  insert(values) {
    const { stmt } = this._prepared(this._insertSql);
    return stmt.run(values);   // named binding, zero arg-array allocation
  }
  where(conds) { return new Query(this).where(conds); }
}

class Query {
  constructor(table) { this.table = table; this._conds = []; this._params = []; }
  where(conds) {
    for (const k in conds) {
      const us = k.lastIndexOf('_'); let col = k, op = '=';
      if (us > 0) { const m = { gt:'>',gte:'>=',lt:'<',lte:'<=',ne:'!=' }[k.slice(us+1)]; if (m) { col = k.slice(0,us); op = m; } }
      this._conds.push({ col, op }); this._params.push(conds[k]);
    }
    return this;
  }
  _key() { return 'W:' + this._conds.map(c => c.col + c.op).join('&'); }
  all() {
    const t = this.table; const key = this._key();
    let e = t._stmtCache.get(key);
    if (!e) {
      const where = this._conds.map(c => `${c.col}${c.op}?`).join(' AND ');
      const stmt = t.db.prepare(`SELECT ${t._selectList} FROM ${t.name}${where ? ' WHERE ' + where : ''}`); stmt.raw(true);
      e = { stmt, mapper: t._allMapper }; t._stmtCache.set(key, e);
    }
    const rows = e.stmt.all(...this._params); const m = e.mapper;
    const out = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) out[i] = m(rows[i]);
    return out;
  }
}
export function table(db, name, columns) { return new Table(db, name, columns); }
