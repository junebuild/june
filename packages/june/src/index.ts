// @junejs/server — June's host adapters + dev server. Host-coupled (`node:*`
// allowed); it composes ON TOP of the pure `junecore` contract layer.

export { host, type JuneHost, type JuneDb, type RunResult, type ServeHandle, type SpawnedModule } from "./host";
export { loadJuneConfig } from "./config-loader";
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
export { createApp, type JuneApp, type CreateAppOptions } from "./app";
export { startDevServer, type DevServer, type DevServerOptions } from "./dev";
