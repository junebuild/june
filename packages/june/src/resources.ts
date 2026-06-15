// Resource resolution — open the handles declared in june.config.ts `resources`
// and hand them to the pipeline, which runs each request inside runInScope() so
// they resolve AMBIENTLY (`import { db } from "@junejs/db"`). ctx never carries
// them — ctx is identity-only (see route.ts). A resource not declared is never
// opened (and, for static apps, tree-shaken out — the build freeze knows which
// routes touch resources).

import type { ResourceConfig, Resources } from "@junejs/core/resources";

// Import the EDGE-safe d1 adapter directly (not via ./db, which pulls host/
// node:* — that would defeat keeping the worker graph host-free).
import { d1, type D1Database } from "./d1";

// Open every declared resource once. Returns a memoized provider so the same
// long-lived handles are reused across requests (one SQLite connection, etc.).
// Env-unaware — the dev/Node path, where resources are local processes.
export function memoizeResources(
  config?: ResourceConfig,
): () => Promise<Resources> {
  if (!config || (!config.db && !config.kv && !config.blob)) {
    const empty: Resources = {};
    return () => Promise.resolve(empty);
  }
  let opened: Promise<Resources> | null = null;
  return () => {
    if (!opened) {
      opened = (async () => ({
        db: config.db ? await config.db.open() : undefined,
        kv: config.kv ? await config.kv.open() : undefined,
        blob: config.blob ? await config.blob.open() : undefined,
      }))();
    }
    return opened;
  };
}

// The deployed worker's env: the platform bindings the adapter declared in
// wrangler. `DB` is the D1 binding name the workers() adapter emits for a
// declared `db` resource (see adapter.ts ResourcePlan).
export type WorkerEnv = { DB?: D1Database } & Record<string, unknown>;

// Which resources the app declared — a pure descriptor the build bakes into the
// generated worker entry. The worker resolves them from `env` bindings, NOT from
// the user's config: importing the config would drag the host-only sqlite()/dev
// server (node:child_process/http) into the workerd bundle. Local dev opens the
// real factories instead, through memoizeResources() (see app.ts).
export type ResourceFlags = { db?: boolean; kv?: boolean; blob?: boolean };

// The PROD/worker provider. It binds declared resources to their EDGE handles
// from env (env.DB → D1) — the prod half of "sqlite dev → D1 prod, one
// declaration": the same `resources: { db: sqlite() }` runs on D1 at the edge,
// because D1 *is* SQLite (same SQL, same Juno tables). No env binding → the
// handle is absent and the route degrades (ambient `db` unavailable), never a crash.
// Memoized per isolate (env is stable across requests in a workerd isolate).
//
// env is typed `unknown` (it arrives untyped from the runtime) and narrowed to
// WorkerEnv — keeping the provider assignable to WorkerManifest.resources.
export function bindWorkerResources(
  flags: ResourceFlags,
): (env?: unknown) => Promise<Resources> {
  if (!flags.db && !flags.kv && !flags.blob) {
    const empty: Resources = {};
    return () => Promise.resolve(empty);
  }
  let opened: Promise<Resources> | null = null;
  return (rawEnv) => {
    const env = rawEnv as WorkerEnv | undefined;
    if (!opened) {
      opened = (async () => ({
        db: flags.db && env?.DB ? await d1(env.DB).open() : undefined,
        // kv/blob edge bindings (KV/R2) land with their adapters; a declared-but-
        // unbound resource degrades to undefined, the same as db.
      }))();
    }
    return opened;
  };
}
