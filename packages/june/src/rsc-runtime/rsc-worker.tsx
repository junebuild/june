// The RSC worker entry (SSR graph, normal React) — the fetch handler that serves
// an RSC app on a STANDARD target (Cloudflare Workers / Vercel edge), no native
// runtime. Per request it chains the two graphs:
//   1. the server-graph bundle (react-server) renders the app → Flight,
//   2. this graph deserializes the Flight + resolves client references to real
//      modules (the generated consumer manifest) → a React tree,
//   3. wraps it in June's <Document> and streams HTML.
//
// The server bundle is a SEPARATE file (its own react-server React); it is loaded
// at runtime via a computed URL so this (normal-React) bundle never re-bundles it.
import { use } from "react";
import { createFromReadableStream } from "react-server-dom-webpack/client";
import { renderToReadableStream } from "react-dom/server.edge";
import { Document } from "@junejs/core/document";

// Generated per app, aliased at build time:
import { MODULE_MAP } from "june:rsc-client"; // installs __webpack_require__ (side effect) + the moduleMap
import { DOC_CONFIG } from "june:rsc-config"; // the frozen DocumentConfig

type ServerBundle = { renderFlight: () => Promise<string> };

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

async function renderDocument(): Promise<string> {
  // Non-literal specifier → rolldown leaves it as a runtime import, so the
  // react-server server bundle is loaded (not re-bundled) from beside this file.
  const serverUrl = new URL("./server.js", import.meta.url).href;
  const server = (await import(serverUrl)) as ServerBundle;
  const flight = await server.renderFlight();

  const flightStream = new Response(flight).body as ReadableStream<Uint8Array>;
  const tree = createFromReadableStream(flightStream, {
    serverConsumerManifest: { moduleMap: MODULE_MAP, serverModuleMap: null, moduleLoading: null },
  }) as unknown as Promise<React.ReactNode>;

  const html = await renderToReadableStream(
    <Document config={DOC_CONFIG}>
      <Root tree={tree} />
    </Document>,
  );
  if (typeof (html as { allReady?: Promise<void> }).allReady?.then === "function") {
    await (html as unknown as { allReady: Promise<void> }).allReady;
  }
  return "<!DOCTYPE html>" + (await streamToString(html as unknown as ReadableStream<Uint8Array>));
}

export default {
  async fetch(_request: Request): Promise<Response> {
    const body = await renderDocument();
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
