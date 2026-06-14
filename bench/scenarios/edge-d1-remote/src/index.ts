// Real remote D1 benchmark for juno's edge data layer.
// All timings are measured SERVER-SIDE (Worker -> D1 round trips), so they
// exclude client->Worker latency. The axis on D1 is round-trip count, not engine.
//
// Routes:
//   GET /seed            — create + load 100k rows (idempotent)
//   GET /bench?n=500     — raw point-query latency + ingress colo
//   GET /sweep           — sequential vs DB.batch() across batch sizes (the lever)
//   GET /render?k=30     — render-level auto-batch vs naive concurrent (juno's win)
//   GET /session         — Sessions API: primary vs read-replica routing
//   GET /reset           — drop table
//
// Run: fill database_id in wrangler.jsonc, then `wrangler deploy` (real cross-
// region latency) or `wrangler dev --remote`. Then GET /seed, then the routes.

interface D1Result<T = unknown> { results: T[]; meta: any; }
interface D1PreparedStatement {
  bind(...v: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
  raw<T = unknown>(): Promise<T[]>;
}
interface D1Session {
  prepare(sql: string): D1PreparedStatement;
  batch(s: D1PreparedStatement[]): Promise<D1Result[]>;
  getBookmark(): string | null;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(s: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<unknown>;
  withSession(constraint?: string): D1Session;
}
interface Env { DB: D1Database; }

const ROWS = 100000;
const json = (o: unknown) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
const colo = (req: Request) => (req as any).cf?.colo ?? "?";

// median + p95 of an array of numbers (ms)
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
  return { median: at(0.5), p95: at(0.95), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const DB = env.DB;
    const where = { colo_ingress: colo(req) };

    if (url.pathname === "/seed") {
      await DB.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, a INTEGER, b TEXT)");
      const c0 = await DB.prepare("SELECT count(*) AS c FROM t").first<number>("c");
      if ((c0 ?? 0) < ROWS) {
        await DB.exec("DELETE FROM t");
        // D1 caps statement size; seed in chunks of 10k via recursive CTE.
        for (let base = 0; base < ROWS; base += 10000) {
          await DB.prepare(
            `INSERT INTO t(id,a,b) WITH RECURSIVE seq(i) AS (SELECT ${base + 1} UNION ALL SELECT i+1 FROM seq WHERE i<${base + 10000}) SELECT i,i,'row'||i FROM seq`,
          ).run();
        }
      }
      const c = await DB.prepare("SELECT count(*) AS c FROM t").first<number>("c");
      return json({ ...where, seeded: c });
    }

    if (url.pathname === "/reset") {
      await DB.exec("DROP TABLE IF EXISTS t");
      return json({ ...where, dropped: true });
    }

    if (url.pathname === "/bench") {
      const N = Number(url.searchParams.get("n") ?? 500);
      const stmt = DB.prepare("SELECT a,b FROM t WHERE id=?");
      const lat: number[] = [];
      let sink = 0;
      for (let i = 0; i < 20; i++) await stmt.bind((i % ROWS) + 1).first(); // warmup
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const r = await stmt.bind((i % ROWS) + 1).first<{ a: number; b: string }>();
        lat.push(performance.now() - t0);
        sink += (r?.a ?? 0) + (r?.b?.length ?? 0);
      }
      const st = stats(lat);
      return json({ ...where, n: N, per_query_ms: st, ops_per_s: Math.round(1000 / st.median), sink });
    }

    if (url.pathname === "/sweep") {
      // sequential N awaits vs one DB.batch() of N, across sizes.
      const sizes = [1, 5, 10, 25, 50, 100];
      const REP = Number(url.searchParams.get("rep") ?? 8);
      const mk = (j: number) => DB.prepare("SELECT a,b FROM t WHERE id=?").bind((j * 137 % ROWS) + 1);
      await DB.batch([mk(0), mk(1)]); // warmup
      const out: any[] = [];
      for (const B of sizes) {
        const seqRuns: number[] = [], batRuns: number[] = [];
        for (let r = 0; r < REP; r++) {
          let t0 = performance.now();
          for (let j = 0; j < B; j++) await mk(j).first();
          seqRuns.push(performance.now() - t0);
          t0 = performance.now();
          await DB.batch(Array.from({ length: B }, (_, j) => mk(j)));
          batRuns.push(performance.now() - t0);
        }
        const seq = stats(seqRuns).median, bat = stats(batRuns).median;
        out.push({ batch: B, sequential_ms: seq, batched_ms: bat, speedup: +(seq / bat).toFixed(1) });
      }
      return json({ ...where, rep: REP, sweep: out });
    }

    if (url.pathname === "/render") {
      // render-level auto-batch: K sibling components each need 1 row.
      const K = Number(url.searchParams.get("k") ?? 30);
      const REP = Number(url.searchParams.get("rep") ?? 30);
      const ids = Array.from({ length: K }, (_, j) => (j * 137 % ROWS) + 1);
      const q = (id: number) => DB.prepare("SELECT a,b FROM t WHERE id=?").bind(id);

      const naiveConcurrent = async () => {
        const rows = await Promise.all(ids.map((id) => q(id).first<{ a: number; b: string }>()));
        return rows.reduce((s, r) => s + (r?.a ?? 0) + (r?.b?.length ?? 0), 0);
      };
      const autoBatch = async () => {
        // request-scoped DataLoader: every load() in the render wave -> one DB.batch()
        let queue: { id: number; resolve: (r: any) => void }[] = [];
        let scheduled = false;
        const flush = async () => {
          const b = queue; queue = []; scheduled = false;
          const res = await DB.batch(b.map((x) => q(x.id)));
          b.forEach((x, i) => x.resolve(res[i].results[0]));
        };
        const load = (id: number) => new Promise<any>((resolve) => {
          queue.push({ id, resolve });
          if (!scheduled) { scheduled = true; queueMicrotask(flush); }
        });
        const rows = await Promise.all(ids.map((id) => load(id)));
        return rows.reduce((s, r) => s + (r?.a ?? 0) + (r?.b?.length ?? 0), 0);
      };
      const time = async (fn: () => Promise<number>) => {
        await fn(); const runs: number[] = [];
        for (let i = 0; i < REP; i++) { const t0 = performance.now(); await fn(); runs.push(performance.now() - t0); }
        return stats(runs).median;
      };
      const conc = await time(naiveConcurrent);
      const batched = await time(autoBatch);
      return json({ ...where, components: K, rep: REP, naive_concurrent_ms: conc, auto_batch_ms: batched, speedup_vs_concurrent: +(conc / batched).toFixed(1) });
    }

    if (url.pathname === "/session") {
      // Sessions API: route reads to nearest replica vs always-primary.
      // (Requires read replication enabled on the DB: read_replication.mode=auto.)
      const N = Number(url.searchParams.get("n") ?? 100);
      const run = async (constraint: string) => {
        let session: D1Session, bookmark: string | null = null;
        try { session = DB.withSession(constraint); }
        catch (e: any) { return { error: String(e?.message ?? e) }; }
        const lat: number[] = [];
        const stmt = session.prepare("SELECT a,b FROM t WHERE id=?");
        for (let i = 0; i < 10; i++) await stmt.bind((i % ROWS) + 1).first();
        for (let i = 0; i < N; i++) {
          const t0 = performance.now();
          await stmt.bind((i % ROWS) + 1).first();
          lat.push(performance.now() - t0);
        }
        try { bookmark = session.getBookmark(); } catch {}
        return { per_query_ms: stats(lat), bookmark_present: !!bookmark };
      };
      return json({
        ...where, n: N,
        first_primary: await run("first-primary"),
        first_unconstrained: await run("first-unconstrained"),
        note: "first-unconstrained may serve from a read replica (if replication enabled); first-primary anchors on primary then reads replicas.",
      });
    }

    return new Response("juno D1 bench. routes: /seed /bench?n= /sweep /render?k= /session /reset\n");
  },
};
