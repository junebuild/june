// The fs side of config: load the user's june.config.{ts,js} from the app root.
// @junejs/core/config owns the SCHEMA and the pure resolvers (defineJune,
// resolveAgent, resolveSpeculationRules); this host module is the only place
// that touches the filesystem — keeping node:* out of the pure layer.
//
// Reminder (rebuild-plan Phase 2): "the dev server never reading june.config.ts
// went unnoticed for days." A config value MUST change observable output — the
// dev server's config-changes-output test guards exactly this.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { JuneConfig } from "@junejs/core/config";

// Probe the given dir AND its parent: callers pass either the app root
// (build/deploy) or the routes dir `app/` (serve) — the config file lives at
// the app root in both layouts.
//
// Config resolution order (first found wins):
//   1. june.config.ts / june.config.js  — the user's own config
//   2. .june/config.ts                  — framework-generated config (e.g. written by
//                                         a wrapper CLI before invoking june); lives in
//                                         june's own artifact dir (gitignored), so the
//                                         wrapper framework never needs to add files to
//                                         the app root.
/** The config file loadJuneConfig would import, or null. Exported so callers that need a FRESH
 *  load (a subprocess probe — see generateContent's bootstrap retry) target the same file the
 *  in-process loader would. */
export function findJuneConfigPath(appDir: string): string | null {
  for (const dir of [appDir, join(appDir, "..")]) {
    for (const name of ["june.config.ts", "june.config.js", ".june/config.ts"]) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

export async function loadJuneConfig(appDir: string): Promise<JuneConfig> {
  const path = findJuneConfigPath(appDir);
  if (!path) return {};
  const mod = (await import(pathToFileURL(path).href)) as { default?: JuneConfig };
  return mod.default ?? {};
}
