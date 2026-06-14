// @junejs/server — June's host adapters + dev server. Host-coupled (`node:*`
// allowed); it composes ON TOP of the pure `@junejs/core` contract layer.

export {
  workers,
  type JuneAdapter,
  type AdapterCapabilities,
  type ResourcePlan,
  type AdapterEntry,
  type AdapterEmitContext,
} from "./adapter";
export { host, type JuneHost, type JuneDb, type RunResult, type ServeHandle, type SpawnedModule } from "./host";
export { sqlite, d1, type D1Database } from "./db";
export { memoryKv, redisKv } from "./kv";
export { localBlob, r2, type R2Bucket } from "./blob";
export {
  memoizeResources,
  bindWorkerResources,
  type WorkerEnv,
  type ResourceFlags,
} from "./resources";
// Ambient data resources (db/kv/blob) live in their own package, `@junejs/db` —
// `import { db } from "@junejs/db"`. The host opens the resources and runs each
// request in the scope they read (pipeline imports runInScope from @junejs/db).
export { loadJuneConfig } from "./config-loader";
export {
  migrate,
  migrateApp,
  classify,
  readMigrations,
  blockedMessage,
  type Migration,
  type MigrateResult,
} from "./migrate";
export { collection, entry, type ContentEntry } from "./content";
export {
  listRoutes,
  matchRoute,
  matchRouteTree,
  resolveNotFound,
  type RouteMatch,
  type RouteTreeMatch,
  type SegmentMatch,
  type MatchOptions,
} from "./router";
export { installAsyncContext } from "./instrumentation";
export { negotiate, type Negotiated } from "./negotiate";
export {
  createPipeline,
  type Pipeline,
  type PipelineConfig,
  type RouteResolver,
  type Resolved,
  type LayoutComponent,
} from "./pipeline";
export { createApp, type JuneApp, type CreateAppOptions } from "./app";
export { createWorker, type WorkerManifest } from "./worker";
export {
  juneBuild,
  buildManifest,
  scanRoutes,
  generateContent,
  freezeConfig,
  type BuildResult,
} from "./build";
export { juneDeploy, type DeployResult } from "./deploy";
export { migrateD1, wranglerD1, resolveD1Database, type D1Exec } from "./d1-migrate";
export { startDevServer, type DevServer, type DevServerOptions } from "./dev";
