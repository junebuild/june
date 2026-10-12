// typstRenderer — a PdfRenderer on the Typst compiler built for WebAssembly
// (@myriaddreamin/typst.ts). Markdown → Typst source (markdown-typst.ts) → PDF, in process,
// with no browser and no native binary. Verified on Bun and Node. Cloudflare Workers allow
// 64 MiB uncompressed per Worker, so the 28 MB module fits, but this renderer is not yet
// verified on workerd: there, pass the compiled module as `wasm` (the default loader reads
// it with node:fs), mind the 128 MB of memory an isolate's requests share, and expect the
// Free plan's 10 ms of CPU to be too little. Measured 2026-10-12 on Bun 1.3.14: ~550 ms to
// initialize once per process (fonts included), then ~30 ms per one-page document.
//
// A separate entry (@junejs/pdf/typst) so an app that renders with something else never
// references the compiler, and the compiler itself is imported on the first render, so an
// agent that never produces a PDF never loads it.
//
// Fonts are the renderer's job. typst.ts's hosted assets (Libertinus Serif, New Computer
// Modern, DejaVu Sans Mono; "cjk" adds a Simplified Chinese Noto Serif subset) are fetched
// from jsdelivr at init unless disabled. Traditional Chinese, Japanese and Korean text needs
// a font that covers it — pass its bytes or URL in `fonts`, or the missing glyphs render
// blank.

import type { TypstCompiler } from "@myriaddreamin/typst.ts/compiler";

import { typstSource } from "./markdown-typst";
import { PdfRenderError, type PdfDocument, type PdfRenderer } from "./renderer";

export type TypstFontAsset = "text" | "cjk" | "emoji";

export type TypstRendererOptions = {
  // Extra font files: bytes, or URLs fetched at init.
  fonts?: (Uint8Array | string)[];
  // typst.ts's hosted font sets to load at init (default ["text", "cjk"]); false loads none,
  // for a deployment that supplies every font through `fonts` and makes no network call.
  fontAssets?: TypstFontAsset[] | false;
  // Where the hosted font sets are fetched from (default: jsdelivr) — a mirror you control.
  fontAssetUrl?: string;
  // Font families in order of preference, e.g. ["Noto Sans TC"]. Typst still falls back to
  // any loaded font that has a glyph.
  fontFamilies?: string[];
  // The compiler's WASM module: its bytes, a compiled module, or a loader. Default: the file
  // @myriaddreamin/typst-ts-web-compiler ships, read from disk. typst.ts instantiates the
  // module once per process, so the first renderer to initialize decides it.
  wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | (() => Promise<Uint8Array | ArrayBuffer | WebAssembly.Module>);
  // How URLs in `fonts` and the hosted font sets are fetched (default: global fetch).
  fetcher?: typeof fetch;
};

const MAIN = "/main.typ";
const PDF_FORMAT = 1; // CompileFormatEnum.pdf — a const enum value, inlined so no runtime import is needed

type Diagnostic = { path?: string; range?: string; severity?: string; message?: string };

export function typstRenderer(opts: TypstRendererOptions = {}): PdfRenderer {
  let compiler: Promise<TypstCompiler> | undefined;
  // One compiler holds one main file: renders run one at a time, in call order.
  let queue: Promise<unknown> = Promise.resolve();

  const ready = (): Promise<TypstCompiler> =>
    (compiler ??= init(opts).catch((err: unknown) => {
      compiler = undefined; // a failed init (offline font fetch, missing WASM) is retried next render
      throw err;
    }));

  async function compile(doc: PdfDocument): Promise<Uint8Array> {
    const c = await ready();
    c.addSource(MAIN, typstSource(doc, { fonts: opts.fontFamilies }));
    const out = (await c.compile({ mainFilePath: MAIN, format: PDF_FORMAT, diagnostics: "full" })) as { result?: Uint8Array; diagnostics?: Diagnostic[] };
    if (!out.result?.byteLength) {
      const errors = (out.diagnostics ?? []).filter((d) => d.severity !== "warning");
      const detail = errors.map((d) => `${d.range ? `${d.range}: ` : ""}${d.message ?? "unknown error"}`).join("; ");
      throw new PdfRenderError(`the document could not be typeset${detail ? `: ${detail}` : ""}`);
    }
    return out.result;
  }

  return {
    name: "typst",
    render(doc) {
      const run = queue.then(() => compile(doc));
      queue = run.catch(() => {});
      return run;
    },
  };
}

async function init(opts: TypstRendererOptions): Promise<TypstCompiler> {
  const { createTypstCompiler, initOptions } = await import("@myriaddreamin/typst.ts");
  const compiler = createTypstCompiler();
  const fonts = initOptions.loadFonts(opts.fonts ?? [], {
    assets: opts.fontAssets === false ? false : (opts.fontAssets ?? ["text", "cjk"]),
    ...(opts.fontAssetUrl ? { assetUrlPrefix: opts.fontAssetUrl } : {}),
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
  });
  await compiler.init({ getModule: () => loadWasm(opts.wasm), beforeBuild: [fonts] });
  return compiler;
}

async function loadWasm(wasm: TypstRendererOptions["wasm"]): Promise<Uint8Array | ArrayBuffer | WebAssembly.Module> {
  if (typeof wasm === "function") return wasm();
  if (wasm) return wasm;
  // The package's own file, from disk: the hosts this renderer targets all have node:fs, and
  // fetch() of a file: URL works on Bun but not on Node.
  const url = import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/wasm");
  const [{ readFile }, { fileURLToPath }] = await Promise.all([import("node:fs/promises"), import("node:url")]);
  return new Uint8Array(await readFile(fileURLToPath(url)));
}
