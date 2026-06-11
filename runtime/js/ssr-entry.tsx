// SSR bundle — built WITHOUT the react-server condition.
// Consumes a Flight string and renders HTML.
// Exposes globalThis.__renderHtml(flight: string): Promise<string>.
//
// This is the half Bun cannot host in the same process as the server bundle:
// here it's a separate module graph that, in Rust, will live in the SAME V8
// runtime as the server graph.

import "./install-streams";
import { use } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { createFromReadableStream } from "react-server-dom-webpack/client.edge";
import { Counter } from "./Counter";
import { streamToString } from "./shims";

const CLIENT_MODULES: Record<string, Record<string, unknown>> = {
  Counter: { Counter },
};

const moduleMap = {
  Counter: { Counter: { id: "Counter", chunks: [], name: "Counter" } },
};

const req = ((id: string) => CLIENT_MODULES[id]) as ((id: string) => unknown) & {
  u: (id: string) => string;
};
req.u = (id: string) => id;

const g = globalThis as Record<string, unknown>;
g.__webpack_require__ = req;
g.__webpack_chunk_load__ = () => Promise.resolve();

function Root({ tree }: { tree: Promise<unknown> }) {
  return use(tree) as React.ReactNode;
}

function createTree(flightStream: ReadableStream<Uint8Array>) {
  return createFromReadableStream(flightStream, {
    serverConsumerManifest: { moduleMap, moduleLoading: null, serverModuleMap: null },
  }) as Promise<unknown>;
}

function documentTree(tree: Promise<unknown>) {
  return (
    <html lang="en">
      <body>
        <div id="root">
          <Root tree={tree} />
        </div>
      </body>
    </html>
  );
}

// Consumes the Flight ReadableStream produced by the server bundle directly.
g.__renderHtmlStream = async function (flightStream: ReadableStream<Uint8Array>) {
  return await renderToReadableStream(documentTree(createTree(flightStream)));
};

g.__renderHtml = async function (flightStream: ReadableStream<Uint8Array>) {
  const html = await renderToReadableStream(documentTree(createTree(flightStream)));
  return await streamToString(html);
};
