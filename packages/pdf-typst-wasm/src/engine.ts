// The JS side of the engine's C ABI (src/lib.rs `ffi`). Plain WebAssembly, no host APIs, so
// it runs unchanged on Node, Bun, Deno and workerd. One instance is one engine: create it
// once per process or isolate and keep it — instantiating costs a fresh linear memory and
// re-registers the embedded fonts.

export type FontScope = "persistent" | "document";

export interface TypstEngine {
  // Register a font file; returns the number of faces it held (0: not a font).
  addFont(data: Uint8Array, scope: FontScope): number;
  // Drop the document-scoped fonts.
  clearDocumentFonts(): void;
  // Typst source → PDF bytes. Throws TypstCompileError with the document's diagnostics.
  compile(source: string): Uint8Array;
  // The engine's linear memory, in bytes (it only grows).
  memoryBytes(): number;
}

export class TypstCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypstCompileError";
  }
}

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  init(): number;
  add_font(ptr: number, len: number, document: number): number;
  clear_document_fonts(): void;
  compile(ptr: number, len: number): number;
  output_ptr(): number;
  output_len(): number;
};

export type WasmSource = WebAssembly.Module | BufferSource;

export async function createEngine(wasm: WasmSource): Promise<TypstEngine> {
  // A Module instantiates to an Instance; bytes to { module, instance }.
  const made = (await WebAssembly.instantiate(wasm as BufferSource, {})) as unknown as WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource;
  const instance = made instanceof WebAssembly.Instance ? made : made.instance;
  const x = instance.exports as unknown as Exports;
  x.init(); // embedded fonts now, not inside the first render

  // Copy bytes into the module's memory; the callee takes ownership of the buffer. The view
  // is taken after alloc, which may grow (and so detach) the memory.
  const put = (bytes: Uint8Array): number => {
    const ptr = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  };
  const output = (): Uint8Array => new Uint8Array(x.memory.buffer, x.output_ptr(), x.output_len()).slice();
  const utf8 = new TextEncoder();

  return {
    addFont(data, scope) {
      return x.add_font(put(data), data.length, scope === "document" ? 1 : 0);
    },
    clearDocumentFonts() {
      x.clear_document_fonts();
    },
    compile(source) {
      const bytes = utf8.encode(source);
      const status = x.compile(put(bytes), bytes.length);
      const out = output();
      if (status !== 0) throw new TypstCompileError(new TextDecoder().decode(out));
      return out;
    },
    memoryBytes() {
      return x.memory.buffer.byteLength;
    },
  };
}
