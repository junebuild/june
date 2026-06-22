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
import type { I18nConfig } from "./i18n";
import type { JuneDb, ResourceConfig } from "./resources";

export type AgentConfig = {
  enabled: boolean; // master switch
  discovery: boolean; // Link header, llms.txt, sitemap, api-catalog, mcp server-card
  mcp: boolean; // the /mcp execution endpoint
  webmcp: boolean; // inject WebMCP tool registrations into the view
  // Optional llms.txt customization for apps built ON June (e.g. the Kura docs framework):
  //   framework — replaces the built-in "canonical names" block so a meta-framework can point
  //               agents at ITS scaffold/scope instead of June's.
  //   sections  — extra Markdown lines appended (e.g. a list of every doc page + its `.md`).
  // Both are plain string arrays so they freeze into the worker manifest as-is.
  llms?: { framework?: string[]; sections?: string[] };
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

// An opt-in Tier-3 data layer (e.g. Juno). A generic seam — core names only this
// shape, so config can declare a data layer without the framework depending on it.
// The user's config imports the layer (`dataLayer: junoDataLayer()`); the framework
// never does. `install()` is called once at boot (the dev host calls it directly);
// `module` lets `june build` emit the same boot into the generated worker — it
// imports `installDataLayer` from there. Both run the same wiring (Juno registers
// its SQL tagger so the ambient `db` auto-tags).
export interface DataLayer {
  install(): void;
  readonly module: string;
  // Optional schema codegen. `june db types` opens the migrated db and calls this to
  // get the type-declaration text (e.g. a `declare module` augmentation), then writes
  // db/schema.d.ts. Type-only import of JuneDb keeps this layer node-free. Layers
  // without typed schemas simply omit it.
  emitTypes?(db: JuneDb): Promise<string>;
}

export type JuneConfig = {
  agent?: Partial<AgentConfig>;
  cache?: CacheStoreFactory; // memory() (default) | redis({ url }) | custom
  // Data resources (db / blob / kv), declared = enabled. Generic names, not
  // Cloudflare-branded; each has a zero-config local default and deploy
  // adapters. Omit one and it never exists. See docs/data-layer-boundary.md.
  resources?: ResourceConfig;
  // Opt-in Tier-3 data layer (e.g. `junoDataLayer()`). Declared = its install()
  // runs at boot. Omit it and the ambient `db` stays raw (Tier 1/2). Explicit, so
  // there is no import-time global side-effect deciding behavior.
  dataLayer?: DataLayer;
  speculation?: SpeculationConfig | false; // false = no speculation rules at all
  // Cross-document View Transitions (@view-transition CSS): MPA navigations
  // animate with ZERO JS; browsers without support (or users with
  // prefers-reduced-motion) get instant navigation — the floor.
  //   true (default) → snappy 120ms cross-fade (not the hazy ~250ms UA default,
  //                    which reads as lag on a prerendered/instant navigation)
  //   number         → cross-fade duration in ms (0 = instant cut)
  //   "instant"      → cross-document activation with no animation
  //   false          → no @view-transition rule at all
  viewTransitions?: boolean | "instant" | number; // default true
  // June's built-in zero-config defaults: a Tailwind-Preflight-aligned baseline reset (box-sizing,
  // body margin, form/button normalize — :where()-wrapped, zero specificity) PLUS the starter look
  // (page background, a centered 720px reading column, inline-code chips). The starter look is
  // full-specificity and unlayered, so it would override your own CSS; both turn off together.
  // DEFAULT: auto — ON, but OFF when app/global.css opts into Tailwind (Preflight is the reset and
  // your CSS owns the look). Set explicitly true/false to override the detection.
  cssReset?: boolean; // default: on; auto-off when Tailwind is detected
  // Opt-in client router. OFF by default — June's floor is browser-native MPA
  // navigation (speculation prerender + View Transitions = SPA feel, zero JS).
  // Turn it on for app-like surfaces (dashboards) that need in-memory state to
  // survive navigation: with it, same-origin link clicks become soft swaps
  // (fetch the next page — the SAME document the server already serves — replace
  // the [data-june-root] region, re-hydrate islands) and an <Island persist>
  // (e.g. a websocket) is carried across navigations instead of torn down.
  // Pure progressive enhancement: it degrades to a hard navigation when JS is
  // off or a fetch fails, and never touches the agent surface — every URL is
  // still a complete, projectable (.md/.json/mcp) document.
  //
  // Three states, so the APPLIER (the wire format) is the author's explicit
  // choice — Flight is never the silent default:
  //   false (default) — browser-native MPA navigation; zero added JS.
  //   true | "morph"  — soft nav via MORPH (HTML-over-wire): fetch the next
  //                     page's fragment and reconcile it. The recommended
  //                     applier — one representation, agent surfaces intact,
  //                     island state preserved without annotation.
  //   "flight"        — soft nav via FLIGHT (React VDOM-over-wire). EXPLICIT
  //                     opt-in only: finer-grained streaming updates at the cost
  //                     of a React-only second wire format. `true` NEVER implies
  //                     it — you must name "flight" — so the HTML/zero-JS promise
  //                     only ever yields when the author asks for it.
  clientRouter?: boolean | "morph" | "flight"; // default false
  // Early Hints (IETF RFC 8297): Link rel=preload values for critical assets
  // (fonts/CSS), e.g. ["</fonts/inter.woff2>; rel=preload; as=font; crossorigin"].
  // Floor: sent as a Link header on HTML responses (Cloudflare upgrades it to
  // a real 103 at the edge). On the Node host, June emits the 103 itself.
  earlyHints?: string[];
  // Site-wide metadata defaults: per-route metadata merges over these.
  // titleTemplate: "%s" is replaced by the route's title ("%s — Acme").
  // lang: the document-language floor for `<html lang>` (default "en"); i18n's
  // per-request locale overrides it when configured.
  site?: { name?: string; titleTemplate?: string; description?: string; icon?: string; lang?: string };
  // Locale routing. OFF by absence: omit it and June does no locale handling
  // (today's behavior — the resolution step never runs, ctx.locale is undefined).
  // Present, it lights up host/path → locale resolution, ctx.locale, and
  // localeHref. This is Layer 1 (routing) only; the message catalog is separate
  // (a future @junejs/i18n). See docs/i18n.md.
  i18n?: I18nConfig;
  // `june build` options. external: packages left UNBUNDLED in dist/worker.js
  // (wrangler resolves them at deploy with its own rules — needed for packages
  // that import .wasm, e.g. workers-og).
  build?: { external?: string[] };
  // `june deploy` options. The deploy VERB is fixed; the target is an adapter
  // (same seam philosophy as JuneHost) — "workers" today, "node"/"june-cloud"
  // later. name defaults to package.json name. domain attaches a Workers
  // custom domain (the zone must live in the same Cloudflare account).
  // `adapter` is a deploy adapter (e.g. vercel()) — absent ⇒ the built-in
  // workers() default. Typed loosely here so @junejs/core stays free of the
  // server-side adapter implementation; build.ts casts it to JuneAdapter.
  deploy?: { target?: "workers"; name?: string; domain?: string; adapter?: unknown };
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

// The navigation applier the runtime activates. "off" = MPA (no router). "morph"
// = HTML-over-wire (the default soft-nav applier). "flight" = React VDOM-over-wire
// (explicit opt-in). The host + document branch on this; the client reads it back
// off the [data-june-root] element (data-june-router) to start the right applier.
export type RouterMode = "off" | "morph" | "flight";

// Normalize the three-state clientRouter into an explicit applier mode. `true`
// and "morph" both mean morph — Flight is reachable ONLY by naming "flight", so
// it can never become the silent default of the common `clientRouter: true`.
export function resolveClientRouter(value: JuneConfig["clientRouter"]): RouterMode {
  if (value === "flight") return "flight";
  if (value === true || value === "morph") return "morph";
  return "off";
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
