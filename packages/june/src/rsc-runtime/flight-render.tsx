// Server-graph entry (bundled with the react-server condition): render the app to
// a React Flight stream. Worker-safe — uses server.edge under the hood. The app
// is injected as "june:app" by the build's alias.
import { renderToReadableStream } from "react-server-dom-webpack/server";

import { App, clientManifest } from "june:app";

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

// Render the app to a Flight payload string. (A real server would stream the
// ReadableStream straight to the response; the string form is for tests + the
// SSR step.)
export async function renderFlight(): Promise<string> {
  const stream = renderToReadableStream(<App />, clientManifest ?? {});
  return streamToString(stream);
}
