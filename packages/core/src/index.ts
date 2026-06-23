// @junejs/core — the agent-native React framework.
//
// This barrel re-exports the PURE, host-free contract layer (Phase 1). Each
// concern is also importable by subpath (`@junejs/core/route`, `@junejs/core/agent`,
// `@junejs/core/mcp`, ...) so apps and host adapters pull in exactly what they need
// without dragging the whole surface into a Workers bundle.
//
// Host-coupled pieces (the dev server, build/deploy, the fs config loader, the
// content pipeline, the data layer) layer ON TOP of this in later phases — they
// never live here, because nothing in this file may touch `node:*` or `Bun.*`.

// Routing + content negotiation
export {
  route,
  isRouteDefinition,
  resolveProjection,
  routeFromModule,
  type RenderTarget,
  type Metadata,
  type RouteContext,
  type RouteCache,
  type RouteDefinition,
  type BrandedRoute,
  type PageModule,
  type Loaded,
} from "./route";

// Config schema + pure resolvers
export {
  defineJune,
  resolveAgent,
  resolveSpeculationRules,
  type AgentConfig,
  type SpeculationConfig,
  type JuneConfig,
} from "./config";

// The data resource contract (the seam the framework depends on, not an ORM)
export type {
  JuneDb,
  JuneKv,
  JuneBlob,
  RunResult,
  DbFactory,
  KvFactory,
  BlobFactory,
  ResourceConfig,
  Resources,
} from "./resources";

// Request-scoped context: the principal + resources routes and actions receive
export type { Principal, Session, ActionContext } from "./context";

// The shared document shell
export {
  Document,
  documentTitle,
  viewTransitionCss,
  PREFETCH_FALLBACK,
  type DocumentConfig,
} from "./document";

// Segment-scoped swap boundary — opt a layout into being a persistent shell
export { JuneOutlet } from "./outlet";

// Client islands — the marker contract. Authoring is `<Counter client:visible/>`
// via jsxImportSource: "@junejs/core" (the jsx-runtime); no wrapper, no transform.
export {
  serializeIslandProps,
  deserializeIslandProps,
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
  type Strategy,
} from "./islands";

// The unified action registry (UI action == MCP tool == WebMCP tool)
export {
  defineAction,
  invokeAction,
  validateInput,
  setServerReferenceRegistrar,
  ACTION_REGISTRY,
  type ActionDefinition,
  type AnyAction,
  type JsonSchema,
  type InferInput,
} from "./agent";

// Agent discovery emitters
export {
  buildLinkHeader,
  llmsTxt,
  robotsTxt,
  sitemapXml,
  apiCatalog,
  mcpServerCard,
} from "./discovery";

// The Web-standard MCP endpoint
export { mcpHandler, mcpTools } from "./mcp";

// Cache primitives + the CacheStore seam
export {
  cache,
  invalidate,
  memory,
  redis,
  registerCache,
  configureCache,
  type CacheEntry,
  type CacheStore,
  type CacheStoreFactory,
  type CacheOptions,
} from "./cache";

// Request tracing (host installs the async-context provider)
export {
  installTraceContext,
  tracingEnabled,
  currentTrace,
  runWithTrace,
  recordTableRead,
  recordTableWrite,
  recordTiming,
  measure,
  type RequestTrace,
  type AsyncContext,
  type TimingKind,
} from "./instrumentation";
