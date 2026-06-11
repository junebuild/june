// route() — a single route definition that feeds one `load()` into multiple
// content-negotiated projections.
//
//   export default route({
//     async load(ctx) { return { users: await Users.all() }; },
//     view({ users })  { return <UsersPage users={users} />; },  // HTML / Flight
//     json({ users })  { return { users }; },                    // data API
//     agent({ users }) { return manifest.resource("users", users); },
//   });
//
// The same data, three representations, never drifting apart. `view` is the
// React projection (named `view`, not `html`, because the framework decides
// HTML-SSR vs RSC Flight by negotiation). `json` is the plain data API. `agent`
// is the capability-described resource for agent clients.

import type { JuneDb, JuneKv, JuneBlob } from "./resources";
import type { Principal, Session } from "./context";

export type RenderTarget = "view" | "json" | "agent" | "md";

// Per-route document metadata. Static metadata keeps the streaming shell;
// a FUNCTION (deriving from load() data) forces an eager load — the <head>
// streams first, so dynamic metadata costs the loading-boundary for that
// route. Choose per route.
export type Metadata = {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string; // e.g. "noindex"
  openGraph?: {
    title?: string;
    description?: string;
    image?: string;
    type?: string; // "website" | "article" | ...
  };
};

export type RouteContext<
  TParams extends Record<string, string> = Record<string, string>,
> = {
  request: Request;
  url: URL;
  params: TParams;
  target: RenderTarget;
  // True when the request is SPECULATIVE (Sec-Purpose: prefetch / prerender):
  // the page may never be seen. Skip side effects — view counters, analytics,
  // rate-limit consumption. (Client-side twin: defer pageviews until
  // !document.prerendering.)
  speculative?: boolean;
  // Resource handles injected by the host (the binding model), present only when
  // declared in june.config.ts `resources`. The framework depends on these
  // contracts, never on a specific ORM — see docs/data-layer-boundary.md.
  db?: JuneDb;
  kv?: JuneKv;
  blob?: JuneBlob;
  // The authenticated principal, populated by the auth integration off the
  // request (undefined until @junejs/auth is wired). Routes gate on ctx.user;
  // the SAME principal reaches actions via ActionContext.
  user?: Principal;
  session?: Session;
};

export type RouteCache = {
  ttl?: number; // seconds; omit for no expiry (tag-invalidated only)
  swr?: number; // extra stale-while-revalidate window, seconds (needs ttl)
  tags?: string[]; // a mutation calling invalidate(tag) drops this route's cache
};

export type RouteDefinition<TData = unknown> = {
  load?: (ctx: RouteContext) => TData | Promise<TData>;
  view?: (data: TData, ctx: RouteContext) => React.ReactNode;
  json?: (data: TData, ctx: RouteContext) => unknown | Promise<unknown>;
  agent?: (data: TData, ctx: RouteContext) => unknown | Promise<unknown>;
  // Markdown projection. If absent, the `md` target is auto-derived from `json`.
  md?: (data: TData, ctx: RouteContext) => string | Promise<string>;
  // Response cache: cache the rendered output of GET requests, keyed by
  // target+URL, dropped by tag invalidation. Uses @junejs/core/cache.
  cache?: RouteCache;
  // `june build` renders this route's projections (html/md/json) to static
  // files served by the Workers assets layer BEFORE the worker runs (0ms).
  // Static routes only; opt-in because it freezes per-request behavior.
  prerender?: boolean;
  // Document metadata for the view projection (title/description/OG/...).
  metadata?: Metadata | ((data: TData, ctx: RouteContext) => Metadata);
};

const ROUTE_BRAND = Symbol.for("june.route");

export type BrandedRoute<TData = unknown> = RouteDefinition<TData> & {
  [ROUTE_BRAND]: true;
};

export function route<TData>(def: RouteDefinition<TData>): BrandedRoute<TData> {
  return { ...def, [ROUTE_BRAND]: true };
}

export function isRouteDefinition(value: unknown): value is BrandedRoute {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[ROUTE_BRAND] === true
  );
}

// The order each requested target degrades through when a projection is absent.
// An agent asking for /users.agent on a route with no `agent()` still gets the
// JSON projection rather than a 406.
const FALLBACK: Record<RenderTarget, RenderTarget[]> = {
  agent: ["agent", "json", "view"],
  json: ["json", "agent", "view"],
  view: ["view", "json", "agent"],
  // `md` is handled specially (auto-derived from json when md() is absent);
  // this entry is only the last-resort fall-through.
  md: ["md", "json", "view"],
};

export function resolveProjection(
  def: BrandedRoute,
  requested: RenderTarget,
): RenderTarget {
  return FALLBACK[requested].find((t) => typeof def[t] === "function") ?? "view";
}
