// juno compile-once prototype vs hand-written raw better-sqlite3 (the floor).
// Run: npm install && node bench.mjs
import { makeDb, seed, bench, report } from './harness.mjs';
import { table } from './juno.mjs';

const N = 10000;
const db = makeDb();
seed(db, N);

const junoUsers = table(db, 'users', [
  { col: 'id', prop: 'id' },
  { col: 'name', prop: 'name' },
  { col: 'email', prop: 'email' },
  { col: 'age', prop: 'age' },
  { col: 'active', prop: 'active' },
  { col: 'bio', prop: 'bio' },
  { col: 'created_at', prop: 'createdAt' },
]);

// raw prepared statements (the floor)
const rawById = db.prepare('SELECT id,name,email,age,active,bio,created_at FROM users WHERE id=?');
const rawByIdRaw = db.prepare('SELECT id,name,email,age,active,bio,created_at FROM users WHERE id=?').raw(true);
const rawRangeRaw = db.prepare('SELECT id,name,email,age,active,bio,created_at FROM users WHERE age>? AND active=?').raw(true);
function rawMap(r){return {id:r[0],name:r[1],email:r[2],age:r[3],active:r[4],bio:r[5],createdAt:r[6]};}

console.log(`=== Point SELECT by id (${N} rows table, in-memory) ===`);
report([
  bench('raw bs3 (object mode)', i => rawById.get((i % N) + 1)),
  bench('raw bs3 .raw()+map (floor)', i => rawMap(rawByIdRaw.get((i % N) + 1))),
  bench('juno findById (compiled)', i => junoUsers.findById((i % N) + 1)),
]);

console.log(`\n=== Range SELECT: age > 40 AND active = 1 (returns ~many rows) ===`);
report([
  bench('raw bs3 .raw()+map loop (floor)', () => { const rs = rawRangeRaw.all(40, 1); const o = new Array(rs.length); for (let j=0;j<rs.length;j++) o[j]=rawMap(rs[j]); return o; }, { iters: 5000, warmup: 1000 }),
  bench('juno .where().all() (memoized plan)', () => junoUsers.where({ age_gt: 40, active: 1 }).all(), { iters: 5000, warmup: 1000 }),
]);

console.log(`\n=== INSERT single row ===`);
const rawIns = db.prepare('INSERT INTO users (id,name,email,age,active,bio,created_at) VALUES (?,?,?,?,?,?,?)');
let idc = N + 1;
report([
  bench('raw bs3 insert (floor)', () => { const id = idc++; rawIns.run(id,'U'+id,'e'+id,30,1,'b',1700000000); }, { iters: 50000, warmup: 5000 }),
  bench('juno insert (named-bind compiled)', () => { const id = idc++; junoUsers.insert({id,name:'U'+id,email:'e'+id,age:30,active:1,bio:'b',createdAt:1700000000}); }, { iters: 50000, warmup: 5000 }),
]);

// correctness sanity: juno output must equal the raw mapping
const a = rawMap(rawByIdRaw.get(5));
const b = junoUsers.findById(5);
console.log('\nsanity (row id=5 raw == juno):', JSON.stringify(a) === JSON.stringify(b));
