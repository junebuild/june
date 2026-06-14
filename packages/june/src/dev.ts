// `june dev` — wire the request pipeline to a host and listen.
//
// Steps: install the async-context provider (so tracing + cache auto-tagging
// work), load june.config.ts from the app root (the config the PoC forgot to
// read), build the app, and serve through the detected JuneHost.

import { watch } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname } from "node:path";

import { loadJuneConfig } from "./config-loader";
import { installAsyncContext } from "./instrumentation";
import { createApp } from "./app";
import { withLiveReload, notifyCssChange } from "./dev-reload";
import { host as defaultHost, type JuneHost, type ServeHandle } from "./host";
import { migrateApp, blockedMessage } from "./migrate";
import { findGlobalCss, processCssCached, invalidateCss } from "./css";

export type DevServerOptions = {
  appDir: string;
  port?: number;
  host?: JuneHost;
};

export type DevServer = ServeHandle & { url: string };

// A taken default port must not be a dead end in dev — walk forward until a
// port binds (the Vite convention). Probed with node:net, which both hosts
// implement, so the host interface stays untouched.
async function findFreePort(start: number, tries = 20): Promise<number> {
  for (let p = start; p < start + tries; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.listen(p, () => probe.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error(`june dev: no free port between ${start} and ${start + tries - 1}`);
}

export async function startDevServer({
  appDir,
  port = 3000,
  host = defaultHost,
}: DevServerOptions): Promise<DevServer> {
  await installAsyncContext();
  const config = await loadJuneConfig(appDir);

  // Apply pending migrations before serving — dev auto-applies the SAFE ones; a
  // destructive one is reported and skipped (the server still starts, but the
  // route using the new schema will fail until you run it explicitly).
  const m = await migrateApp(dirname(appDir), config);
  if (m?.applied.length) console.log(`[june] migrated: ${m.applied.join(", ")}`);
  if (m?.blocked) console.warn(`[june] ${blockedMessage(m.blocked)}`);

  const app = createApp({ appDir, config });
  await app.warmup();

  const freePort = await findFreePort(port);
  if (freePort !== port) console.log(`[june] port ${port} is taken → using ${freePort}`);
  port = freePort;

  // Live reload wraps the DEV SERVER only — the pipeline (and therefore
  // dev/built parity) never sees it. See dev-reload.ts.
  const handle = host.serve(withLiveReload((req) => app.fetch(req)), {
    port,
    earlyHints: () => app.earlyHints(),
  });

  // CSS hot-swap: a stylesheet edit pushes a `css` event to open browsers, which
  // re-fetch /global.css and swap the <link> WITHOUT reloading (island state +
  // scroll survive). The supervisor ignores .css so it won't restart over it; a
  // .tsx edit still restarts → full reload (its markup changed too).
  if (findGlobalCss(appDir)) {
    watch(appDir, { recursive: true }, (_event, file) => {
      if (file && file.endsWith(".css")) {
        invalidateCss(); // next /global.css recompiles fresh
        notifyCssChange();
      }
    });
    // Warm + cache the stylesheet in the background: Tailwind v4's native engine
    // costs ~700ms to load and ~145ms to build its design system ONCE. Doing it
    // now (while the user reads the dev URL) overlaps that with startup AND
    // populates the cache, so the first page's stylesheet is instant — and every
    // later navigation serves from cache (recompile only after an edit).
    void processCssCached(appDir).catch(() => {});
  }

  const url = `http://localhost:${handle.port}`;
  console.log(`june dev → ${url}  (host: ${host.name})`);
  return { ...handle, url };
}
