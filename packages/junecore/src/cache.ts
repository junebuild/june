// Cache primitives — first-class, not an afterthought (benchmarks show cache is
// the difference between a render-bound ~5k rps and the native HTTP ceiling).
//
//   cache(fn, { key, ttl, tags })  memoize an async result
//   invalidate(tag)                drop every entry carrying a tag
//
// Same adapter shape as the data layer: a CacheStore seam with a built-in
// in-memory store (full tag support) and pluggable backends (redis, KV) behind
// the same interface. The framework's route response cache uses this too.
//
// PURITY: the in-memory store and all of cache()/invalidate() are host-free.
// The only host touch is the redis() factory's connect(), which dynamic-imports
// "bun" through a NON-LITERAL specifier so no bundler resolves it statically —
// the import only runs if a host opts into the redis store.

import { currentTrace, recordTiming } from "./instrumentation";

export type CacheEntry = {
  value: unknown;
  expiresAt: number | null; // fresh until this epoch ms (null = always fresh)
  staleUntil: number | null; // servable-stale until this epoch ms (null = never dies)
  tags: string[];
};

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  invalidateTag(tag: string): Promise<void>;
}

export interface CacheStoreFactory {
  readonly kind: string;
  connect(): Promise<CacheStore>;
}

// Built-in in-memory store with a tag -> keys index for O(tag) invalidation.
class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Alive (fresh or servable-stale) until staleUntil; cache() decides which.
    if (entry.staleUntil !== null && entry.staleUntil < Date.now()) {
      await this.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await this.delete(key); // clear any stale tag links
    this.entries.set(key, entry);
    for (const tag of entry.tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) this.tagIndex.set(tag, (keys = new Set()));
      keys.add(key);
    }
  }

  async delete(key: string): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry) {
      for (const tag of entry.tags) this.tagIndex.get(tag)?.delete(key);
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    const keys = this.tagIndex.get(tag);
    if (!keys) return;
    for (const key of [...keys]) await this.delete(key);
    this.tagIndex.delete(tag);
  }
}

let store: CacheStore | null = null;

export function registerCache(s: CacheStore) {
  store = s;
}

export async function configureCache(factory: CacheStoreFactory) {
  store = await factory.connect();
}

function active(): CacheStore {
  // Zero-config fallback: the built-in in-memory store.
  return store ?? (store = new MemoryStore());
}

export type CacheOptions = {
  key: string;
  ttl?: number; // fresh window, seconds
  swr?: number; // extra stale-while-revalidate window, seconds (needs ttl)
  tags?: string[];
};

function entryOf(opts: CacheOptions, value: unknown, tags: string[]): CacheEntry {
  const now = Date.now();
  const expiresAt = opts.ttl ? now + opts.ttl * 1000 : null;
  const staleUntil =
    expiresAt !== null && opts.swr ? expiresAt + opts.swr * 1000 : expiresAt;
  return { value, expiresAt, staleUntil, tags };
}

// Coalesce background refreshes so a burst of stale hits triggers one recompute.
const revalidating = new Set<string>();

async function revalidate<T>(
  s: CacheStore,
  fn: () => T | Promise<T>,
  opts: CacheOptions,
  tags: string[], // reuse the stale entry's tags (no request trace in the background)
) {
  if (revalidating.has(opts.key)) return;
  revalidating.add(opts.key);
  try {
    await s.set(opts.key, entryOf(opts, await fn(), tags));
  } catch {
    /* keep serving the stale value */
  } finally {
    revalidating.delete(opts.key);
  }
}

// Memoize an async result. Fresh hits return immediately; within the SWR window
// a stale value is returned immediately while a refresh runs in the background.
export async function cache<T>(
  fn: () => T | Promise<T>,
  opts: CacheOptions,
): Promise<T> {
  const s = active();
  const entry = await s.get(opts.key);

  if (entry) {
    const fresh = entry.expiresAt === null || entry.expiresAt > Date.now();
    if (fresh) {
      recordTiming("cache", "HIT", 0, opts.key);
      return entry.value as T;
    }
    // Stale but within the SWR window: serve stale now, refresh in background.
    recordTiming("cache", "STALE", 0, opts.key);
    void revalidate(s, fn, opts, entry.tags);
    return entry.value as T;
  }

  // Miss — auto-tag by the tables fn() reads (diff the trace before/after), so
  // invalidation works without hand-declared tags. Explicit tags merge in.
  const before = new Set(currentTrace()?.reads ?? []);
  const value = await fn();
  const autoTags = [...(currentTrace()?.reads ?? [])]
    .filter((t) => !before.has(t))
    .map((t) => `table:${t}`);

  await s.set(opts.key, entryOf(opts, value, [...(opts.tags ?? []), ...autoTags]));
  recordTiming(
    "cache",
    "MISS",
    0,
    `${opts.key}${autoTags.length ? ` [${autoTags.join(",")}]` : ""}`,
  );
  return value;
}

// Drop every cache entry carrying this tag. Call from mutations.
export async function invalidate(tag: string): Promise<void> {
  await active().invalidateTag(tag);
}

// Config form: `cache: memory()` (default) or `cache: redis({ url })`.
export function memory(): CacheStoreFactory {
  return {
    kind: "memory",
    async connect() {
      return new MemoryStore();
    },
  };
}

// Redis-backed store (Bun's native client). Tags use Redis sets for O(tag)
// invalidation. Needs a Redis server — same seam as the in-memory store.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

class RedisStore implements CacheStore {
  constructor(private readonly client: RedisLike) {}

  async get(key: string): Promise<CacheEntry | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.staleUntil !== null && entry.staleUntil < Date.now()) {
      await this.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await this.client.set(key, JSON.stringify(entry));
    if (entry.staleUntil) {
      await this.client.expire(key, Math.ceil((entry.staleUntil - Date.now()) / 1000));
    }
    for (const tag of entry.tags) await this.client.sadd(`tag:${tag}`, key);
  }

  async delete(key: string): Promise<void> {
    const raw = await this.client.get(key);
    await this.client.del(key);
    if (raw) {
      const entry = JSON.parse(raw) as CacheEntry;
      for (const tag of entry.tags) await this.client.srem(`tag:${tag}`, key);
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    for (const key of await this.client.smembers(`tag:${tag}`)) await this.delete(key);
    await this.client.del(`tag:${tag}`);
  }
}

export function redis(opts: { url: string }): CacheStoreFactory {
  return {
    kind: "redis",
    async connect() {
      // Non-literal specifier: bundlers (wrangler/esbuild for Workers) must not
      // try to resolve "bun" — it exists only at Bun runtime.
      const bunSpecifier = "bun";
      const mod = (await import(bunSpecifier)) as unknown as {
        RedisClient: new (url: string) => RedisLike;
      };
      return new RedisStore(new mod.RedisClient(opts.url));
    },
  };
}
