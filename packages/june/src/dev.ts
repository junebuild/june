// `june dev` — wire the request pipeline to a host and listen.
//
// Steps: install the async-context provider (so tracing + cache auto-tagging
// work), load june.config.ts from the app root (the config the PoC forgot to
// read), build the app, and serve through the detected JuneHost.

import { loadJuneConfig } from "./config-loader";
import { installAsyncContext } from "./instrumentation";
import { createApp } from "./app";
import { host as defaultHost, type JuneHost, type ServeHandle } from "./host";

export type DevServerOptions = {
  appDir: string;
  port?: number;
  host?: JuneHost;
};

export type DevServer = ServeHandle & { url: string };

export async function startDevServer({
  appDir,
  port = 3000,
  host = defaultHost,
}: DevServerOptions): Promise<DevServer> {
  await installAsyncContext();
  const config = await loadJuneConfig(appDir);
  const app = createApp({ appDir, config });
  await app.warmup();

  const handle = host.serve((req) => app.fetch(req), {
    port,
    earlyHints: () => app.earlyHints(),
  });

  const url = `http://localhost:${handle.port}`;
  console.log(`june dev → ${url}  (host: ${host.name})`);
  return { ...handle, url };
}
