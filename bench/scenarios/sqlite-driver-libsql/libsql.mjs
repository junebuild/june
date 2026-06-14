// libSQL: (1) `libsql` sync native binding (better-sqlite3-compatible) vs
//         better-sqlite3, (2) `@libsql/client` async client — the per-call
//         Promise tax. Run: npm install && node libsql.mjs
import Database from 'better-sqlite3';
import LibsqlDatabase from 'libsql';
import { createClient } from '@libsql/client';
import fs from 'node:fs';

function fresh(p){for(const s of ['','-wal','-shm','-journal']){try{fs.unlinkSync(p+s)}catch{}}}
const DIR = new URL('.', import.meta.url).pathname;
const DDL=`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,age INTEGER NOT NULL,active INTEGER NOT NULL,bio TEXT,created_at INTEGER NOT NULL)`;
const SEL='SELECT id,name,email,age,active,bio,created_at FROM users WHERE id=?';
const ALL='SELECT id,name,email,age,active,bio,created_at FROM users';
const INS='INSERT INTO users (id,name,email,age,active,bio,created_at) VALUES (?,?,?,?,?,?,?)';
const N=10000;
function map(r){return {id:r[0],name:r[1],email:r[2],age:r[3],active:r[4],bio:r[5],createdAt:r[6]};}
function fmtI(v){return Math.round(v).toLocaleString().padStart(12);}

function benchSync(name, fn, {iters,warmup}){ for(let i=0;i<warmup;i++)fn(i); const t=process.hrtime.bigint(); for(let i=0;i<iters;i++)fn(i); const ns=Number(process.hrtime.bigint()-t); console.log('  '+name.padEnd(32)+fmtI(iters/ns*1e9)+' ops/s'); }
async function benchAsync(name, fn, {iters,warmup}){ for(let i=0;i<warmup;i++)await fn(i); const t=process.hrtime.bigint(); for(let i=0;i<iters;i++)await fn(i); const ns=Number(process.hrtime.bigint()-t); console.log('  '+name.padEnd(32)+fmtI(iters/ns*1e9)+' ops/s'); }

function seedBs3(){ fresh(DIR+'l-bs3.db'); const db=new Database(DIR+'l-bs3.db'); db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL'); db.exec(DDL); const ins=db.prepare(INS); db.transaction(()=>{for(let i=1;i<=N;i++)ins.run(i,'User'+i,'u'+i+'@e.com',30,1,'bio'+i,1)})(); return db; }
function seedLibsqlSync(){ fresh(DIR+'l-sync.db'); const db=new LibsqlDatabase(DIR+'l-sync.db'); db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL'); db.exec(DDL); const ins=db.prepare(INS); db.transaction(()=>{for(let i=1;i<=N;i++)ins.run(i,'User'+i,'u'+i+'@e.com',30,1,'bio'+i,1)})(); return db; }

console.log('## Point SELECT by id, file WAL — sync bindings (raw()+codegen map) ##');
const bs3=seedBs3(), lss=seedLibsqlSync();
const sBs3=bs3.prepare(SEL).raw(true);
const sLss=lss.prepare(SEL).raw(true);
benchSync('better-sqlite3 .raw()', i=>map(sBs3.get((i%N)+1)), {iters:300000,warmup:30000});
benchSync('libsql (sync) .raw()', i=>map(sLss.get((i%N)+1)), {iters:300000,warmup:30000});

console.log('\n## Bulk SELECT all 10k rows, file WAL — sync (raw()+map) ##');
const aBs3=bs3.prepare(ALL).raw(true), aLss=lss.prepare(ALL).raw(true);
benchSync('better-sqlite3 bulk .raw()+map', ()=>{const rs=aBs3.all();const o=new Array(rs.length);for(let i=0;i<rs.length;i++)o[i]=map(rs[i]);return o;}, {iters:3000,warmup:300});
benchSync('libsql (sync) bulk .raw()+map', ()=>{const rs=aLss.all();const o=new Array(rs.length);for(let i=0;i<rs.length;i++)o[i]=map(rs[i]);return o;}, {iters:3000,warmup:300});

console.log('\n## INSERT single row, file WAL — sync (autocommit) ##');
const iBs3=bs3.prepare(INS), iLss=lss.prepare(INS);
let a=N+1,b=N+1;
benchSync('better-sqlite3 insert', ()=>{const id=a++;iBs3.run(id,'U'+id,'e'+id,30,1,'b',1);}, {iters:30000,warmup:1000});
benchSync('libsql (sync) insert', ()=>{const id=b++;iLss.run(id,'U'+id,'e'+id,30,1,'b',1);}, {iters:30000,warmup:1000});

console.log('\n## Point SELECT by id, file WAL — @libsql/client (ASYNC, await per call) ##');
fresh(DIR+'l-async.db');
const client = createClient({ url: 'file:' + DIR + 'l-async.db' });
await client.execute('PRAGMA journal_mode=WAL');
await client.execute('PRAGMA synchronous=NORMAL');
await client.execute(DDL);
{ const stmts = []; for(let i=1;i<=N;i++) stmts.push({sql:INS,args:[i,'User'+i,'u'+i+'@e.com',30,1,'bio'+i,1]}); await client.batch(stmts, 'write'); }
await benchAsync('@libsql/client execute (await)', async i=>{ const r=await client.execute({sql:SEL,args:[(i%N)+1]}); return r.rows[0]; }, {iters:100000,warmup:10000});

console.log('\n(ref: sync libsql point select above is the same engine without the Promise/await overhead)');
process.exit(0);
