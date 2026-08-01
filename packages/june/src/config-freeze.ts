// Freeze june.config.ts → the serializable bits the worker inlines, plus the
// small config-derived helpers (deploy adapter resolution, base path and worker
// name normalization). Extracted from build.ts; consumed by buildManifest and
// juneBuild so both freeze through the SAME code (the parity contract).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveAgent, resolveClientRouter, resolveSpeculationRules } from "@junejs/core/config";
import type { JuneConfig } from "@junejs/core/config";
import type { DocumentConfig } from "@junejs/core/document";
import { workers, vercel, deno, staticSite, type JuneAdapter } from "./adapter";
import { findClientEntry, CLIENT_SCRIPT_URL } from "./client-bundle";
import { loadJuneConfig } from "./config-loader";
import { findGlobalCss, globalCssUsesTailwind, STYLES_URL } from "./css";
import type { WorkerManifest } from "./worker";

// Resolve the deploy adapter from config. An explicit `adapter` INSTANCE wins; otherwise the
// `target` NAME selects the matching built-in — so a DECLARATIVE config (e.g. kura.toml, which
// can't express a `vercel()` call) can pick any target by string, not just "static". "workers" is
// the default. Kept in lockstep with deploy.ts's own target→deployer switch so a build for one
// target is never deployed as another. vercel()/deno() take their opts (runtime/regions, org/app)
// which JuneConfig.deploy doesn't carry yet, so they use defaults here.
export function resolveDeployAdapter(deploy: JuneConfig["deploy"]): JuneAdapter {
  if (deploy?.adapter) return deploy.adapter as JuneAdapter;
  switch (deploy?.target) {
    case "static":
      return staticSite();
    case "vercel":
      return vercel();
    case "deno":
      return deno();
    default:
      return workers({ name: deploy?.name, domain: deploy?.domain });
  }
}

// Freeze june.config.ts → the serializable bits the worker inlines.
export async function freezeConfig(appRoot: string): Promise<{
  document: DocumentConfig;
  agent: WorkerManifest["agent"];
  i18n: WorkerManifest["i18n"];
  earlyHints: string[];
  buildExternal: string[];
}> {
  const cfg = await loadJuneConfig(appRoot);
  // An app with a client entry gets the islands runtime URL frozen into its
  // document. Detected HERE (not just in juneBuild) so the prerender path —
  // which re-freezes through buildManifest — sets the SAME clientScript, keeping
  // prerendered pages byte-equivalent to the live worker (parity).
  // Client entry: app/_client.* wins; fall back to .june/routes/_client.* (framework slot).
  const hasClient =
    findClientEntry(join(appRoot, "app")) !== undefined ||
    findClientEntry(join(appRoot, ".june", "routes")) !== undefined;
  const hasCss = findGlobalCss(join(appRoot, "app")) !== null;
  return {
    document: {
      site: cfg.site ?? {},
      speculationRules: resolveSpeculationRules(cfg.speculation ?? undefined),
      speculationDelivery: "inline",
      viewTransitions: cfg.viewTransitions ?? true,
      // Default the baseline reset OFF when the app uses Tailwind (its Preflight is the reset).
      cssReset: cfg.cssReset ?? !globalCssUsesTailwind(join(appRoot, "app")),
      clientRouter: resolveClientRouter(cfg.clientRouter),
      clientScript: hasClient ? CLIENT_SCRIPT_URL : null,
      styles: hasCss ? STYLES_URL : null,
      // Deploy subpath (JuneConfig.basePath). Frozen so the document prefixes its
      // asset URLs; the prerender path re-freezes through buildManifest and gets the
      // same value, keeping static pages' asset links correct under the subpath.
      basePath: normalizeBase(cfg.basePath),
    },
    agent: resolveAgent(cfg.agent),
    // Pass i18n through as-is: the in-process buildManifest keeps a resolveLocale
    // hook (parity test), and the codegen JSON.stringify drops the function
    // (worker hook support is the codegen pass — see the manifest field comment).
    i18n: cfg.i18n,
    earlyHints: cfg.earlyHints ?? [],
    buildExternal: cfg.build?.external ?? [],
  };
}

// A deploy basePath is stored with a leading slash and no trailing slash; empty
// ("" — the default) means a root deploy. So "/openab/docs/" → "/openab/docs",
// "openab" → "/openab", undefined → "".
export function normalizeBase(base?: string): string {
  if (!base) return "";
  const b = base.startsWith("/") ? base : `/${base}`;
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

// A wrangler-valid worker name from a package name or directory name. Wrangler requires lowercase
// [a-z0-9-] not starting/ending with a dash — so a SCOPED package name (`@scope/pkg`) must lose its
// scope (else the `@` sanitizes to a leading dash and wrangler rejects the config). Drop the scope,
// lowercase, collapse non-alphanumerics to single dashes, trim edge dashes; fall back to "app" if
// nothing survives (e.g. an all-punctuation name). Exported for tests.
export function workerName(raw: string): string {
  return (
    raw
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}
