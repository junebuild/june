// Ambient per-request findBy auto-batch — does scattered, no-loader findBy collapse
// to one query? Run: `cd packages/juno && bun bench/ambient-batch.ts`.
// (Workspace bench: lives with the package so @junejs/* resolve via the package's
// node_modules; uses the real juno over an in-memory sqlite handle.)
//
// The honest metric is QUERY COUNT: on D1 each query is a network round trip + a
// billed subrequest under a concurrency cap, so 1-vs-K is the real win. The
// wall-clock section injects a per-query latency and a D1-like concurrency cap to
// show the time payoff. Real remote-D1 ground truth (bench/scenarios/edge-d1-remote):
// ~225ms/RTT, batch sweep ~81x at K=100.

import { host } from "@junejs/server/host";
import type { JuneDb } from "@junejs/core/resources";

import { juno } from "../src";

const sleep = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Wrap a JuneDb to count query()/get() and inject per-call latency.
function instrument(db: JuneDb, latencyMs = 0) {
  let queries = 0;
  let gets = 0;
  const wrapped: JuneDb = {
    ...db,
    query: async (sql, p) => { queries++; await sleep(latencyMs); return db.query(sql, p); },
    get: async (sql, p) => { gets++; await sleep(latencyMs); return db.get(sql, p); },
  };
  return { db: wrapped, counts: () => ({ queries, gets }) };
}

// Run fn over items with at most `limit` in flight (models D1's subrequest cap).
async function mapLimit<A, B>(items: A[], limit: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
    }),
  );
  return out;
}

const SEL = "select * from users where id = ? limit 1";

async function main() {
  const raw = await host.openDb(":memory:");
  await raw.exec("create table users (id integer primary key, name text)");
  const N = 2000;
  for (let i = 1; i <= N; i++) await raw.run("insert into users (name) values (?)", ["User" + i]);
  const idsOf = (K: number) => Array.from({ length: K }, (_, i) => ((i * 7) % N) + 1);

  console.log("=== QUERY COUNT: scattered per-component findBy (the real D1-round-trip metric) ===");
  for (const K of [10, 30, 100]) {
    const ids = idsOf(K);
    const a = instrument(raw);
    const t = juno(a.db).table<{ id: number; name: string }>("users");
    await Promise.all(ids.map((id) => t.findBy({ id }))); // ambient
    const ambient = a.counts().queries;

    const b = instrument(raw);
    await Promise.all(ids.map((id) => b.db.get(SEL, [id]))); // naive per-component
    const naive = b.counts().gets;

    console.log(`  K=${String(K).padStart(3)}: ambient findBy = ${ambient} query   |   naive per-component = ${naive} queries   (${naive}x fewer round trips)`);
  }

  console.log("\n=== WALL-CLOCK: 30 components, injected latency, D1-like concurrency cap = 6 ===");
  const L = 5; // ms per "round trip"
  const CAP = 6;
  const ids = idsOf(30);

  let s = performance.now();
  const ta = juno(instrument(raw, L).db).table<{ id: number; name: string }>("users");
  await Promise.all(ids.map((id) => ta.findBy({ id })));
  const ambientMs = performance.now() - s;

  const cap = instrument(raw, L);
  s = performance.now();
  await mapLimit(ids, CAP, (id) => cap.db.get(SEL, [id]));
  const cappedMs = performance.now() - s;

  const seq = instrument(raw, L);
  s = performance.now();
  for (const id of ids) await seq.db.get(SEL, [id]);
  const seqMs = performance.now() - s;

  console.log(`  ambient findBy (1 batch):     ${ambientMs.toFixed(1)} ms`);
  console.log(`  naive concurrent (cap ${CAP}):    ${cappedMs.toFixed(1)} ms   (~ceil(30/${CAP}) round trips)`);
  console.log(`  naive sequential (N+1):       ${seqMs.toFixed(1)} ms   (30 round trips)`);
  console.log(`  -> ambient is ${(cappedMs / ambientMs).toFixed(1)}x vs capped-concurrent, ${(seqMs / ambientMs).toFixed(1)}x vs sequential`);

  process.exit(0);
}
main();
