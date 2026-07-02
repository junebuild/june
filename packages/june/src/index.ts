// @junejs/server — June's host adapters + dev server. Host-coupled (`node:*`
// allowed); it composes ON TOP of the pure `@junejs/core` contract layer.

export {
  workers,
  vercel,
  deno,
  staticSite,
  type JuneAdapter,
  type AdapterCapabilities,
  type ResourcePlan,
  type AdapterEntry,
  type AdapterEmitContext,
} from "./adapter";
export { host, type JuneHost, type JuneDb, type RunResult, type ServeHandle, type SpawnedModule } from "./host";
export { sqlite, d1, postgres, mysql, turso, type D1Database } from "./db";
export { memoryKv, redisKv } from "./kv";
export { localBlob, r2, type R2Bucket } from "./blob";
export {
  memoizeResources,
  bindWorkerResources,
  type WorkerEnv,
  type ResourceFlags,
} from "./resources";
// Ambient data resources (db/kv/blob) live in `@junejs/db`; re-exported here so
// `import { db } from "@junejs/server"` is the ONE canonical handle. It auto-tags
// raw queries when Juno is installed (Juno registers the tagger via @junejs/db) —
// so the framework never imports Juno, yet `db` is the tagging one in a Juno app.
export { db, kv, blob } from "@junejs/db";
export { loadJuneConfig } from "./config-loader";
export {
  migrate,
  migrateApp,
  typesApp,
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
// Locale routing (Layer 1). The pure host-resolution layer lives in @junejs/core;
// re-exported here so apps build locale links with `localeHref` off the ONE handle.
export {
  localeHref,
  resolveRequestLocale,
  matchPinnedLocale,
  negotiateLocale,
  parseAcceptLanguage,
  localeDir,
  dirForLang,
  LOCALE_COOKIE,
  type I18nConfig,
  type LocaleConfig,
  type LocaleMatch,
} from "@junejs/core/i18n";
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
