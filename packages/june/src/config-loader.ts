// The fs side of config: load the user's june.config.{ts,js} from the app root.
// junecore/config owns the SCHEMA and the pure resolvers (defineJune,
// resolveAgent, resolveSpeculationRules); this host module is the only place
// that touches the filesystem — keeping node:* out of the pure layer.
//
// Reminder (rebuild-plan Phase 2): "the dev server never reading june.config.ts
// went unnoticed for days." A config value MUST change observable output — the
// dev server's config-changes-output test guards exactly this.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { JuneConfig } from "junecore/config";

// Probe the given dir AND its parent: callers pass either the app root
// (build/deploy) or the routes dir `app/` (serve) — the config file lives at
// the app root in both layouts.
export async function loadJuneConfig(appDir: string): Promise<JuneConfig> {
  for (const dir of [appDir, join(appDir, "..")]) {
    for (const name of ["june.config.ts", "june.config.js"]) {
      const path = join(dir, name);
      if (existsSync(path)) {
        const mod = (await import(pathToFileURL(path).href)) as { default?: JuneConfig };
        return mod.default ?? {};
      }
    }
  }
  return {};
}
