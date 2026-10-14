// @junejs/pdf-typst-wasm on Bun (the `bun` export condition). Everything is node.ts's except
// how the engine module is found: here it is imported `with { type: "file" }`, which
// `bun build --compile` sees and embeds, and which yields the module's path inside the binary
// (/$bunfs/…). node.ts reads ../dist/typst.wasm by URL at first render, which the bundler can't
// see, so a compiled app failed its first render_pdf (#367).
//
// A dynamic import, on the first render: a process that never renders a PDF never reads the
// 29 MiB, and a repo checkout without the built module still loads this file (its tests skip).
// The bundler embeds the file when it exists and doesn't check when it doesn't (verified on Bun
// 1.4.2): a binary compiled from a checkout without it fails at first render, with the message
// below. A published package always ships it.

import { readFile } from "node:fs/promises";

import type { WasmSource } from "./engine";
import { createTypstWasmRenderer, type TypstWasmRenderer, type TypstWasmRendererOptions } from "./renderer";

// The same names as node.ts; the local typstWasmRenderer below takes precedence over its own.
export * from "./node";

let compiled: Promise<WebAssembly.Module> | undefined;
async function loadWasm(): Promise<WasmSource> {
  return (compiled ??= (async () => {
    let path: string;
    try {
      // wasm.d.ts types a .wasm import as a module (workerd); with type "file" it is a path.
      path = ((await import("../dist/typst.wasm", { with: { type: "file" } })) as unknown as { default: string }).default;
    } catch (err) {
      throw new Error("@junejs/pdf-typst-wasm: dist/typst.wasm is missing — in the June repo, run `bun run build` in packages/pdf-typst-wasm", { cause: err });
    }
    return WebAssembly.compile((await readFile(path)) as Uint8Array<ArrayBuffer>);
  })().catch((err: unknown) => {
    compiled = undefined;
    throw err;
  }));
}

export function typstWasmRenderer(opts: TypstWasmRendererOptions = {}): TypstWasmRenderer {
  return createTypstWasmRenderer(loadWasm, opts);
}
