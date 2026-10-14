// @junejs/pdf-typst-wasm on Cloudflare Workers (the `workerd` export condition): the engine
// module is imported, so wrangler uploads it as a compiled WebAssembly module and the
// runtime precompiles it — measured startup on the spike: 2 ms. The Worker needs Workers
// Paid: a warm one-page render takes ~40 ms of CPU, the Free plan allows 10.
//
//   import { pdfTools } from "@junejs/pdf";
//   import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
//   export default pdfTools({ renderer: typstWasmRenderer() });   // offline: embedded fonts only

// The same path from src/ (the repo) and from dist/ (the published package).
import wasm from "../dist/typst.wasm";
import { createTypstWasmRenderer, type TypstWasmRenderer, type TypstWasmRendererOptions } from "./renderer";

export { type TypstWasmRenderer, type TypstWasmRendererOptions } from "./renderer";
export { googleFontSubsets, localFonts, type DocumentFonts, type FontEgress, type FontProvider, type FontSource, type GoogleFont } from "./fonts";
export { createEngine, TypstCompileError, type FontScope, type TypstEngine, type TypstOutput, type WasmSource } from "./engine";

export function typstWasmRenderer(opts: TypstWasmRendererOptions = {}): TypstWasmRenderer {
  return createTypstWasmRenderer(async () => wasm, opts);
}
