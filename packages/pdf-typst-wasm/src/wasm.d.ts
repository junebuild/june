// A `.wasm` import is a compiled module on workerd (wrangler's CompiledWasm rule).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
