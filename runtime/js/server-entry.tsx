// SERVER bundle — built with the `react-server` condition.
// Renders the server component tree to a Flight string.
// Exposes globalThis.__renderFlight(): Promise<string>.

import "./install-streams";
import {
  registerClientReference,
  renderToReadableStream,
} from "react-server-dom-webpack/server.edge";

function clientRef(id: string, name: string) {
  return registerClientReference(
    (() => {
      throw new Error(`client ref ${id} ran on server`);
    }) as unknown as object,
    id,
    name,
  );
}

const CLIENT_MANIFEST = new Proxy(
  {},
  { get: (_t, key: string) => (key.includes("#") ? undefined : { id: key, chunks: [] }) },
) as Record<string, { id: string; chunks: never[] }>;

const Counter = clientRef("Counter", "Counter") as unknown as (props: {
  initial?: number;
}) => unknown;

function App() {
  return (
    <main>
      <h1>June Rust RSC</h1>
      <p>Server component rendered by V8 embedded in a Rust runtime.</p>
      <Counter initial={3} />
    </main>
  );
}

// Returns the Flight ReadableStream directly (no string materialization). The
// SSR bundle consumes this same stream object — both bundles share deno_web's
// global ReadableStream, so the Flight bytes never round-trip through a string.
(globalThis as Record<string, unknown>).__renderFlightStream = function () {
  // For the heavy render benchmark (8 components + markdown-it, network-free),
  // swap <App /> for <BenchHome Counter={Counter} /> (import from "./bench-page").
  // See docs/benchmarks.md "Aligned render-vs-render".
  return renderToReadableStream(<App />, CLIENT_MANIFEST);
};
