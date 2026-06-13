// june.config.ts support — the resource manifest / feature config.
//
// The agent surface (discovery + MCP) is ON by default: it exposes the same
// actions and the same authorization the UI already exposes, so it does not
// widen the attack surface. Gate sensitive actions with permissions, not by
// hiding the endpoint. Turn any of it off here when you must.
//
// PURITY: this module is the config SCHEMA and its pure resolvers only. The
// `loadJuneConfig(appDir)` reader (node:fs / node:path / dynamic import of the
// user's june.config.ts) is a HOST concern and lives in the Phase-2 host layer
// — keeping the contract layer free of `node:*` (zero node:*/Bun.* in this layer).

import type { CacheStoreFactory } from "./cache";
import type { ResourceConfig } from "./resources";

export type AgentConfig = {
  enabled: boolean; // master switch
  discovery: boolean; // Link header, llms.txt, sitemap, api-catalog, mcp server-card
  mcp: boolean; // the /mcp execution endpoint
  webmcp: boolean; // inject WebMCP tool registrations into the view
};

export type SpeculationConfig = {
  // hover-intent prerender: "moderate" (hover) | "conservative" (mousedown,
  // for heavy pages) | false. Default "moderate" — light MPA pages get 0ms
  // navigations for free.
  prerender?: "moderate" | "conservative" | false;
  prefetch?: "moderate" | "conservative" | false;
  // App-specific exclusions, ADDED to the built-in ones (agent surfaces:
  // *.md *.json *.txt *.xml /mcp — those are always excluded).
  exclude?: string[];
  // "inline" (default): rules in a <script type=speculationrules>.
  // "header": rules served at /__june/speculation-rules and referenced by a
  // `Speculation-Rules` response header — smaller HTML, CDN-injectable.
  delivery?: "inline" | "header";
};

export type JuneConfig = {
  agent?: Partial<AgentConfig>;
  cache?: CacheStoreFactory; // memory() (default) | redis({ url }) | custom
  // Data resources (db / blob / kv), declared = enabled. Generic names, not
  // Cloudflare-branded; each has a zero-config local default and deploy
  // adapters. Omit one and it never exists. See docs/data-layer-boundary.md.
  resources?: ResourceConfig;
  speculation?: SpeculationConfig | false; // false = no speculation rules at all
  // Cross-document View Transitions (@view-transition CSS): MPA navigations
  // animate (default cross-fade) with ZERO JS; browsers without support (or
  // users with prefers-reduced-motion) get instant navigation — the floor.
  viewTransitions?: boolean; // default true
  // Early Hints (IETF RFC 8297): Link rel=preload values for critical assets
  // (fonts/CSS), e.g. ["</fonts/inter.woff2>; rel=preload; as=font; crossorigin"].
  // Floor: sent as a Link header on HTML responses (Cloudflare upgrades it to
  // a real 103 at the edge). On the Node host, June emits the 103 itself.
  earlyHints?: string[];
  // Site-wide metadata defaults: per-route metadata merges over these.
  // titleTemplate: "%s" is replaced by the route's title ("%s — Acme").
  site?: { name?: string; titleTemplate?: string; description?: string; icon?: string };
  // `june build` options. external: packages left UNBUNDLED in dist/worker.js
  // (wrangler resolves them at deploy with its own rules — needed for packages
  // that import .wasm, e.g. workers-og).
  build?: { external?: string[] };
  // `june deploy` options. The deploy VERB is fixed; the target is an adapter
  // (same seam philosophy as JuneHost) — "workers" today, "node"/"june-cloud"
  // later. name defaults to package.json name. domain attaches a Workers
  // custom domain (the zone must live in the same Cloudflare account).
  deploy?: { target?: "workers"; name?: string; domain?: string };
};

const DEFAULT_AGENT: AgentConfig = {
  enabled: true,
  discovery: true,
  mcp: true,
  webmcp: true,
};

export function defineJune(config: JuneConfig): JuneConfig {
  return config;
}

export function resolveAgent(partial?: Partial<AgentConfig>): AgentConfig {
  const merged = { ...DEFAULT_AGENT, ...(partial ?? {}) };
  // The master switch turns the whole agent surface off.
  if (!merged.enabled) {
    return { enabled: false, discovery: false, mcp: false, webmcp: false };
  }
  return merged;
}

// --- speculation (hover prerender/prefetch) -----------------------------------

// Agent surfaces are ALWAYS excluded from human-intent speculation — humans
// hover, agents don't; a footer link to llms.txt must not prerender.
const BUILTIN_EXCLUDES = ["/*.md", "/*.json", "/*.txt", "/*.xml", "/mcp"];

export function resolveSpeculationRules(config?: SpeculationConfig | false): string | null {
  if (config === false) return null;
  const prerender = config?.prerender ?? "moderate";
  const prefetch = config?.prefetch ?? "moderate";
  if (!prerender && !prefetch) return null;
  const where = {
    and: [
      { href_matches: "/*" },
      ...[...BUILTIN_EXCLUDES, ...(config?.exclude ?? [])].map((p) => ({
        not: { href_matches: p },
      })),
    ],
  };
  const rules: Record<string, unknown> = {};
  if (prerender) rules.prerender = [{ where, eagerness: prerender }];
  if (prefetch) rules.prefetch = [{ where, eagerness: prefetch }];
  return JSON.stringify(rules);
}
