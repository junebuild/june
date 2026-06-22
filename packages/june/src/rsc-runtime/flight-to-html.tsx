// SSR-graph entry (bundled WITHOUT the react-server condition → normal React):
// consume a Flight stream and render it to HTML. Worker-safe — react-dom's edge
// server build + the client.edge Flight reader, no node:*. This is the first-load
// step: the worker turns Flight into the HTML the browser paints.
import { use } from "react";
import { createFromReadableStream } from "react-server-dom-webpack/client";
import { renderToReadableStream } from "react-dom/server.edge";

// The Flight payload deserializes to a thenable React tree; `use` unwraps it
// inside the render so react-dom can stream it to HTML.
function Root({ tree }: { tree: Promise<React.ReactNode> }): React.ReactNode {
  return use(tree);
}

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

// Turn a Flight payload string into an HTML string. `moduleMap` resolves client
// references to their real components so islands SSR too; an empty map is fine for
// server-only trees (client.edge still requires the manifest object to exist).
export async function flightToHtml(
  flight: string,
  moduleMap: Record<string, unknown> = {},
): Promise<string> {
  const flightStream = new Response(flight).body as ReadableStream<Uint8Array>;
  const tree = createFromReadableStream(flightStream, {
    serverConsumerManifest: { moduleMap, serverModuleMap: null, moduleLoading: null },
  }) as unknown as Promise<React.ReactNode>;
  const html = await renderToReadableStream(<Root tree={tree} />);
  // Non-streaming: wait for the whole document.
  if (typeof (html as { allReady?: Promise<void> }).allReady?.then === "function") {
    await (html as unknown as { allReady: Promise<void> }).allReady;
  }
  return streamToString(html as unknown as ReadableStream<Uint8Array>);
}
