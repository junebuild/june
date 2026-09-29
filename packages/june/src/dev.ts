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
  // The address to bind. Default 127.0.0.1: the dev server is reachable from this
  // machine only (MCP: "when running locally, servers SHOULD bind only to
  // localhost"). "0.0.0.0" opens it to the LAN — `june dev --host`.
  hostname?: string;
  host?: JuneHost;
};

// The Host names a dev server answers /mcp and /api for (#308): localhost and its
// subdomains, plus IP literals (always allowed — rebinding needs a domain name),
// plus a named --host and whatever the config allows.
// The URL to print and return: localhost for loopback or a wildcard bind (it
// answers there too), else the one address bound — nothing listens on loopback then.
export function devUrl(hostname: string, port: number): string {
  if (["127.0.0.1", "0.0.0.0", "::", "localhost"].includes(hostname)) return `http://localhost:${port}`;
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

export function devAllowedHosts(configured: readonly string[] | undefined, hostname: string): string[] {
  const hosts = new Set(["localhost", ".localhost", ...(configured ?? [])]);
  if (!/^[\d.]+$|:/.test(hostname)) hosts.add(hostname.toLowerCase()); // a name, not 0.0.0.0 / an IP
  return [...hosts];
}

// stop() also shuts the app down (its agent runtime, #317); await it to know that's done.
export type DevServer = Omit<ServeHandle, "stop"> & { url: string; stop(force?: boolean): Promise<void> };

// A taken default port must not be a dead end in dev — walk forward until a
// port binds (the Vite convention). Probed with node:net, which both hosts
// implement, so the host interface stays untouched.
async function findFreePort(start: number, hostname: string, tries = 20): Promise<number> {
  for (let p = start; p < start + tries; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.listen(p, hostname, () => probe.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error(`june dev: no free port between ${start} and ${start + tries - 1}`);
}

export async function startDevServer({
  appDir,
  port = 3000,
  hostname = "127.0.0.1",
  host = defaultHost,
}: DevServerOptions): Promise<DevServer> {
  await installAsyncContext();
  const loaded = await loadJuneConfig(appDir);
  // The DNS-rebinding check (#308): a local server is exactly what rebinding targets.
  const config = { ...loaded, agent: { ...loaded.agent, allowedHosts: devAllowedHosts(loaded.agent?.allowedHosts, hostname) } };

  // Apply pending migrations before serving — dev auto-applies the SAFE ones; a
  // destructive one is reported and skipped (the server still starts, but the
  // route using the new schema will fail until you run it explicitly).
  const m = await migrateApp(dirname(appDir), config);
  if (m?.applied.length) console.log(`[june] migrated: ${m.applied.join(", ")}`);
  if (m?.blocked) console.warn(`[june] ${blockedMessage(m.blocked)}`);

  const app = createApp({ appDir, config });
  await app.warmup();

  const freePort = await findFreePort(port, hostname);
  if (freePort !== port) console.log(`[june] port ${port} is taken → using ${freePort}`);
  port = freePort;

  // Live reload wraps the DEV SERVER only — the pipeline (and therefore
  // dev/built parity) never sees it. See dev-reload.ts.
  const handle = host.serve(withLiveReload((req) => app.fetch(req)), {
    port,
    hostname,
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

  const url = devUrl(hostname, handle.port);
  const lan = hostname === "127.0.0.1" ? "" : `  · listening on ${hostname}`;
  console.log(`june dev → ${url}  (host: ${host.name})${lan}`);
  return {
    ...handle,
    url,
    async stop(force?: boolean) {
      handle.stop(force);
      await app.close();
    },
  };
}
