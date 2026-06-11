// EXPERIMENT (task 1): replace deno_web's op-backed ReadableStream (every chunk
// crosses the JS<->Rust boundary via op_readable_stream_resource_*) with a
// pure-JS implementation, to test whether that op overhead is the single-thread
// render bottleneck vs Bun/JSC.
//
// Must be imported FIRST in each bundle, before react-server-dom / react-dom, so
// React captures these globals. The guard ensures only the first-loaded bundle
// installs its copy — both bundles then share ONE ReadableStream class, so the
// Flight stream handed from the server graph to the ssr graph stays instanceof-
// compatible.
import {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  ReadableStream,
  TransformStream,
  WritableStream,
} from "web-streams-polyfill";

const g = globalThis as Record<string, unknown>;
if (!g.__JUNE_PURE_STREAMS__) {
  g.__JUNE_PURE_STREAMS__ = true;
  g.ReadableStream = ReadableStream;
  g.WritableStream = WritableStream;
  g.TransformStream = TransformStream;
  g.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
  g.CountQueuingStrategy = CountQueuingStrategy;
}
