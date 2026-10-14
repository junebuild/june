// @junejs/pdf-typst-wasm on Node, Bun and Deno: the engine module is read from the
// dist/typst.wasm next to this file (relative to src/ in the repo, where `bun run build`
// writes it) and compiled once per process.
//
//   import { pdfTools } from "@junejs/pdf";
//   import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
//   export default pdfTools({ renderer: typstWasmRenderer() });   // offline: embedded fonts only

import type { WasmSource } from "./engine";
import { createTypstWasmRenderer, type TypstWasmRenderer, type TypstWasmRendererOptions } from "./renderer";

export { type TypstWasmRenderer, type TypstWasmRendererOptions } from "./renderer";
export { googleFontSubsets, localFonts, type FontEgress, type FontProvider, type FontSource, type GoogleFont } from "./fonts";
export { createEngine, TypstCompileError, type FontScope, type TypstEngine, type TypstOutput, type WasmSource } from "./engine";

export const WASM_URL = new URL("../dist/typst.wasm", import.meta.url);

let compiled: Promise<WebAssembly.Module> | undefined;
async function loadWasm(): Promise<WasmSource> {
  return (compiled ??= (async () => {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([import("node:fs/promises"), import("node:url")]);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(fileURLToPath(WASM_URL));
    } catch (err) {
      throw new Error(`@junejs/pdf-typst-wasm: ${fileURLToPath(WASM_URL)} is missing — in the June repo, run \`bun run build\` in packages/pdf-typst-wasm`, { cause: err });
    }
    return WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
  })().catch((err: unknown) => {
    compiled = undefined;
    throw err;
  }));
}

export function typstWasmRenderer(opts: TypstWasmRendererOptions = {}): TypstWasmRenderer {
  return createTypstWasmRenderer(loadWasm, opts);
}
