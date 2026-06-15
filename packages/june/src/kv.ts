// `kv` resource adapters. The kv resource IS the cache (docs/data-layer
// .md: "reframe cache as the kv resource — it already is one"): these wrap
// @junejs/core/cache's CacheStore (memory / redis) as the simpler JuneKv contract,
// so there is ONE key-value system, surfaced both as cache() and as ambient kv.

import { memory, redis, type CacheStore } from "@junejs/core/cache";
import type { JuneKv, KvFactory } from "@junejs/core/resources";

function kvOver(store: CacheStore): JuneKv {
  return {
    async get<T>(key: string) {
      const entry = await store.get(key);
      return (entry?.value ?? null) as T | null;
    },
    async put(key: string, value: unknown, opts?: { ttl?: number }) {
      const expiresAt = opts?.ttl ? Date.now() + opts.ttl * 1000 : null;
      await store.set(key, { value, expiresAt, staleUntil: expiresAt, tags: [] });
    },
    async delete(key: string) {
      await store.delete(key);
    },
  };
}

// In-memory kv — the zero-config dev default (same store class cache() uses).
export function memoryKv(): KvFactory {
  return { kind: "memory", open: async () => kvOver(await memory().connect()) };
}

// Redis-backed kv (Bun's native client) — and the shape a Cloudflare KV adapter
// slots into (same JuneKv contract).
export function redisKv(opts: { url: string }): KvFactory {
  return { kind: "redis", open: async () => kvOver(await redis(opts).connect()) };
}
