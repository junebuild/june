// Auto-batch — the flagship data demo (rebuild-plan Phase 5; the render-level
// auto-batch / D1 8.8× number in bench/results.json). When many components each
// ask for a row by key during ONE render pass, a DataLoader-style loader
// coalesces them within a microtask tick into a SINGLE `where key in (...)`
// query: N+1 → 1. Per-request so keys never leak across requests.

import type { JuneDb } from "@junejs/core/resources";
import { recordTableRead } from "@junejs/core/instrumentation";

import type { Row } from "./index";

export type Loader<K, V> = {
  load(key: K): Promise<V | null>;
};

// Generic batched loader: `batchFn(keys)` runs once per tick with all pending
// keys; `keyOf(row)` maps a result back to the key that requested it.
export function createLoader<K, V>(
  batchFn: (keys: K[]) => Promise<V[]>,
  keyOf: (value: V) => K,
): Loader<K, V> {
  let queue: { key: K; resolve: (v: V | null) => void; reject: (e: unknown) => void }[] = [];
  let scheduled = false;

  function flush() {
    const batch = queue;
    queue = [];
    scheduled = false;
    // Dedupe keys so repeated asks for the same row cost nothing extra.
    const keys = [...new Set(batch.map((b) => b.key))];
    batchFn(keys).then(
      (values) => {
        const byKey = new Map(values.map((v) => [keyOf(v), v]));
        for (const b of batch) b.resolve(byKey.get(b.key) ?? null);
      },
      (err) => {
        for (const b of batch) b.reject(err);
      },
    );
  }

  return {
    load(key: K) {
      return new Promise<V | null>((resolve, reject) => {
        queue.push({ key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
    },
  };
}

// A by-key loader over a JuneDb table: `loader.load(id)` calls coalesce into one
// `select * from <table> where <key> in (?, ?, ...)`. Build one per request.
export function tableLoader<V extends Row = Row>(
  db: JuneDb,
  table: string,
  key = "id",
): Loader<string | number, V> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`unsafe SQL identifier: ${table}.${key}`);
  }
  return createLoader<string | number, V>(
    async (keys) => {
      recordTableRead(table); // batched read still participates in cache auto-tagging
      const placeholders = keys.map(() => "?").join(", ");
      return db.query<V>(`select * from ${table} where ${key} in (${placeholders})`, keys);
    },
    (row) => (row as Row)[key] as string | number,
  );
}
