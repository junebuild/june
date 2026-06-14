// Shared bench helpers + schema seeding (raw better-sqlite3).
import Database from 'better-sqlite3';

export function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE users (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      email     TEXT NOT NULL,
      age       INTEGER NOT NULL,
      active    INTEGER NOT NULL,
      bio       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_users_age ON users(age);
  `);
  return db;
}

export function seed(db, n = 10000) {
  const insert = db.prepare(
    'INSERT INTO users (id,name,email,age,active,bio,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const tx = db.transaction(() => {
    for (let i = 1; i <= n; i++) {
      insert.run(i, 'User' + i, 'user' + i + '@ex.com', 18 + (i % 60), i % 2, 'bio ' + i, 1700000000 + i);
    }
  });
  tx();
}

export function bench(name, fn, { iters = 200000, warmup = 20000 } = {}) {
  for (let i = 0; i < warmup; i++) fn(i);
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < iters; i++) {
    const r = fn(i);
    if (r !== undefined) sink ^= (typeof r === 'object' ? 1 : 0);
  }
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);
  const opsPerSec = (iters / ns) * 1e9;
  const nsPerOp = ns / iters;
  return { name, opsPerSec, nsPerOp, sink };
}

export function report(rows) {
  const fastest = Math.max(...rows.map(r => r.opsPerSec));
  console.log('\n' + 'op'.padEnd(34) + 'ops/sec'.padStart(14) + 'ns/op'.padStart(12) + '  rel');
  console.log('-'.repeat(74));
  for (const r of rows) {
    const rel = (r.opsPerSec / fastest * 100).toFixed(0) + '%';
    console.log(
      r.name.padEnd(34) +
      Math.round(r.opsPerSec).toLocaleString().padStart(14) +
      r.nsPerOp.toFixed(0).padStart(12) +
      rel.padStart(6)
    );
  }
}
