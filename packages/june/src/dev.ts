// `june dev` — wire the request pipeline to a host and listen.
//
// Steps: install the async-context provider (so tracing + cache auto-tagging
// work), load june.config.ts from the app root (the config the PoC forgot to
// read), build the app, and serve through the detected JuneHost.

import { createServer as createNetServer } from "node:net";

import { loadJuneConfig } from "./config-loader";
import { installAsyncContext } from "./instrumentation";
import { createApp } from "./app";
import { withLiveReload } from "./dev-reload";
import { host as defaultHost, type JuneHost, type ServeHandle } from "./host";

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

  const url = `http://localhost:${handle.port}`;
  console.log(`june dev → ${url}  (host: ${host.name})`);
  return { ...handle, url };
}
