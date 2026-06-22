// Server-graph entry for PER-ROUTE RSC: render the matched route's view to Flight.
// The route map (path → server-component view) + client manifest are generated and
// injected as "june:rsc-routes". Worker-safe (server.edge via the react-server
// condition).
import { renderToReadableStream } from "react-server-dom-webpack/server";

import { ROUTES, clientManifest } from "june:rsc-routes";

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

// Render the view registered for `path` to a Flight payload, or null if no RSC
// route owns that path (the dispatcher then leaves it to the SSR pipeline).
export async function renderFlight(path: string): Promise<string | null> {
  const View = ROUTES[path];
  if (!View) return null;
  return streamToString(renderToReadableStream(<View />, clientManifest ?? {}));
}

// The paths this RSC bundle owns — the dispatcher routes these here.
export function rscPaths(): string[] {
  return Object.keys(ROUTES);
}
