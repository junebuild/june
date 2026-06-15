// The data RESOURCE contract — the seam the framework depends on, NOT an ORM.
// PURE and host-free: these are type-only declarations (Promises, Web types), no
// `node:*`, no driver. The implementations (sqlite/d1/postgres, local/r2/s3,
// memory/redis) live in @junejs/server's adapters and behind them, Juno; this
// layer only names the contract so RouteContext can carry injected handles and
// any ORM can target the same shape. See docs/data-layer-boundary.md.

// --- db (relational / SQL) --------------------------------------------------

export type RunResult = { changes: number; lastInsertRowid: number | bigint };

// The SQL dialect a JuneDb handle speaks, so a data layer (Juno) can compile the
// right SQL — placeholders (`?` vs `$n`), identifier quoting, upsert syntax — for the
// handle it's given. A pure string tag (no driver import), keeping this contract
// layer host-free. Absent ⇒ treated as "sqlite" (the default; D1 is sqlite too).
export type SqlDialect = "sqlite" | "postgres" | "mysql";

// The async database surface. SELECT → query()/get(); writes → run(); DDL or
// multi-statement scripts → exec(). Async from day one so D1/edge slot in behind
// the same interface (the PoC's sync surface was the one dead end).
export interface JuneDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: JuneDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  // The dialect this handle speaks (default "sqlite" when absent). Set by the driver
  // so Juno picks the matching compiler without the framework knowing about dialects.
  readonly dialect?: SqlDialect;
}

// --- kv (key-value / cache) -------------------------------------------------

export interface JuneKv {
  get<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// --- blob (object / file) ---------------------------------------------------

export interface JuneBlob {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

// --- factories (declared in june.config.ts; opened by the host) -------------
// Same shape as the cache CacheStoreFactory: a `kind` tag + an async open. The
// factory is abstract (pure); the concrete adapter (sqlite/d1/local/r2/...) is
// host code that implements the handle.

export interface DbFactory {
  readonly kind: string;
  open(): Promise<JuneDb>;
}
export interface KvFactory {
  readonly kind: string;
  open(): Promise<JuneKv>;
}
export interface BlobFactory {
  readonly kind: string;
  open(): Promise<JuneBlob>;
}

// What june.config.ts declares under `resources`. Omit one and it never exists
// (not instantiated, not bundled, compiled away for static apps).
export type ResourceConfig = {
  db?: DbFactory;
  kv?: KvFactory;
  blob?: BlobFactory;
};

// The opened handles, injected onto RouteContext by the host. Each is present
// only when the matching resource was declared.
export type Resources = {
  db?: JuneDb;
  kv?: JuneKv;
  blob?: JuneBlob;
};
