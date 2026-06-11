// The HOST INTERFACE — the seam between June's portable core and the JS runtime
// it runs on. The core speaks Web standards (Request/Response/ReadableStream/
// crypto) plus THIS object for the few things standards don't cover: binding a
// port, spawning the react-server Flight subprocess, and the database.
//
// A new deploy target (Workers, creekd, Vercel) is a new implementation of this
// interface, not a change to the framework. This package is the HOST layer —
// static `node:*` imports are fine here (Bun implements the node: builtins too);
// it is the pure `junecore` package, never this one, that must stay node-free.
//
// ASYNC-FIRST DB (the deliberate redesign): the PoC shipped a SYNCHRONOUS
// SqliteDb surface — and that was the one dead end. D1 and every edge database
// are async; an API that returns rows synchronously cannot be implemented on
// them without blocking or buffering hacks. So `JuneDb` is async from day one;
// the Bun/Node SQLite drivers (which happen to be sync) are wrapped, and D1
// (Phase 5) implements the same interface natively. See docs/rebuild-plan.md.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";

// The JuneDb / RunResult CONTRACT now lives in the pure junecore layer
// (junecore/resources) so any ORM can target it. Re-exported here for callers
// that still import from the host.
import type { JuneDb, RunResult } from "junecore/resources";
export type { JuneDb, RunResult };

export type ServeHandle = { port: number; stop(force?: boolean): void };

export type SpawnedModule = {
  stdout: ReadableStream<Uint8Array>;
  stderrText(): Promise<string>;
  exited: Promise<number>;
};

export interface JuneHost {
  readonly name: "bun" | "node";
  serve(
    handler: (req: Request) => Promise<Response>,
    opts: { port: number; earlyHints?: () => string[] },
  ): ServeHandle;
  // Spawn a module in a child runtime (the react-server Flight renderer, which
  // must run under a different module-resolution condition). Phase 4 supersedes
  // this with the in-isolate dual-graph loader; the seam stays for the fallback.
  spawnModule(entry: string, args: string[], opts: { conditions?: string[] }): SpawnedModule;
  // Open a LOCAL SQLite database — the internal primitive the `sqlite()` db
  // adapter builds on (docs/data-layer-boundary.md: openDb is demoted from the
  // user-facing API to a host primitive; apps declare `resources.db` instead).
  openDb(path: string): Promise<JuneDb>;
}

// --- a tiny sync→async SQLite adapter shared by both hosts ------------------

// The shape bun:sqlite exposes directly and node:sqlite is adapted to: a
// prepared statement with positional binding.
type SyncStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
};
type SyncSqlite = {
  query(sql: string): SyncStatement;
  exec(sql: string): void;
  close(): void;
};

// Wrap a synchronous SQLite handle as the async JuneDb. The driver work is
// synchronous, but the SURFACE is async, so swapping in D1 later is invisible
// to every caller.
function asyncSqlite(db: SyncSqlite): JuneDb {
  const self: JuneDb = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.query(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      // Normalize "no row" to undefined — bun:sqlite returns null, node:sqlite
      // returns undefined; the seam hides the difference.
      return (db.query(sql).get(...params) ?? undefined) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      const r = db.query(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid ?? 0 };
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    async transaction<T>(fn: (tx: JuneDb) => Promise<T>) {
      db.exec("BEGIN");
      try {
        const out = await fn(self); // same connection — sqlite is single-writer
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async close() {
      db.close();
    },
  };
  return self;
}

// --- Bun host ---------------------------------------------------------------

function bunHost(): JuneHost {
  return {
    name: "bun",
    serve(handler, opts) {
      const server = Bun.serve({ port: opts.port, fetch: handler });
      return { port: server.port ?? opts.port, stop: (force) => void server.stop(force) };
    },
    spawnModule(entry, args, opts) {
      const cmd = [
        "bun",
        ...(opts.conditions ?? []).flatMap((c) => ["--conditions", c]),
        entry,
        ...args,
      ];
      const child = Bun.spawn({ cmd, cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      return {
        stdout: child.stdout,
        stderrText: () => new Response(child.stderr).text(),
        exited: child.exited,
      };
    },
    async openDb(path) {
      // Non-literal specifier: only Bun has bun:sqlite, so resolve it at runtime.
      const specifier = "bun:sqlite";
      const { Database } = (await import(specifier)) as {
        Database: new (p: string, o?: { create?: boolean }) => SyncSqlite;
      };
      return asyncSqlite(new Database(path, { create: true }));
    },
  };
}

// --- Node host --------------------------------------------------------------

function nodeHost(): JuneHost {
  return {
    name: "node",
    serve(handler, opts) {
      const server = createServer(async (req, res) => {
        try {
          // Real 103 Early Hints (RFC 8297) for document requests — the browser
          // starts fetching critical assets while we render. Node-host exclusive
          // (Bun.serve has no interim-response API; CF reads the Link header).
          const hints = opts.earlyHints?.();
          if (
            hints?.length &&
            req.method === "GET" &&
            (req.headers.accept ?? "").includes("text/html")
          ) {
            res.writeEarlyHints({ link: hints });
          }
          const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const request = new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
            // @ts-expect-error half-duplex is required for streamed request bodies
            duplex: "half",
          });
          const response = await handler(request);
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          if (response.body) {
            Readable.fromWeb(response.body as never).pipe(res);
          } else {
            res.end();
          }
        } catch (err) {
          console.error("[june:node] request failed", err);
          if (!res.headersSent) res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
      server.listen(opts.port);
      return {
        get port() {
          const addr = server.address();
          return typeof addr === "object" && addr ? addr.port : opts.port;
        },
        stop(force) {
          server.close();
          if (force) server.closeAllConnections?.();
        },
      };
    },
    spawnModule(entry, args, opts) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx", // TS-on-Node for the fallback path; `june build` emits dist JS
          ...(opts.conditions ?? []).flatMap((c) => ["--conditions", c]),
          entry,
          ...args,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      const errChunks: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => errChunks.push(c));
      return {
        stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        stderrText: async () => Buffer.concat(errChunks).toString(),
        exited: new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0))),
      };
    },
    async openDb(path) {
      const specifier = "node:sqlite"; // node-only builtin; resolve at runtime
      const { DatabaseSync } = (await import(specifier)) as {
        DatabaseSync: new (p: string) => {
          prepare(sql: string): SyncStatement;
          exec(sql: string): void;
          close(): void;
        };
      };
      const db = new DatabaseSync(path);
      // Adapt node:sqlite (prepare()) to the query()-shaped SyncSqlite surface.
      return asyncSqlite({
        query: (sql) => db.prepare(sql),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      });
    },
  };
}

// bun-types declares the global `Bun`; on Node the binding doesn't exist at
// runtime, which is exactly what the typeof guard checks.
export const host: JuneHost = typeof Bun !== "undefined" ? bunHost() : nodeHost();
